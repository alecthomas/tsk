import type * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import type * as ssa from "golang.org/x/tools/go/ssa";
import { defineAnalyzer, defineFact, type Pass } from "tsk";
import { buildssa } from "tsk/passes";

// Flags describing how a call or closure uses contexts.
const ctxIn = 1; // takes a context
const ctxOut = 2; // returns a context
const ctxInField = 4; // takes a context read from a struct field

// EntryType classifies a function by the context it starts from.
enum EntryType {
  None = 0,
  Normal = 1, // takes no context
  WithCtx = 2, // takes a context
  WithHttpHandler = 3, // is an HTTP handler, whose request holds one
}

// ResInfo is what is known about a function. Funcs is the chain of calls
// that loses the context, innermost first.
interface ResInfo {
  valid?: boolean;
  funcs?: string[];
  entryType?: EntryType;
}

// ctxFact holds a package's results by function, so callers in other
// packages can use them. Entry types are keyed "entry:" plus the function.
const ctxFact = defineFact<Record<string, ResInfo>>("contextcheck");

export default defineAnalyzer({
  name: "contextcheck",
  doc: `check whether the function uses a non-inherited context

A function that has a context should pass it, or one derived from it, to the
functions it calls, rather than making a new one with context.Background or
context.TODO. HTTP handlers should use their request's context.`,
  requires: [buildssa],
  facts: [ctxFact],
  run(pass) {
    new Runner(pass).run();
  },
});

type Element = { pos(): token.Pos; parent(): ssa.Function | null };

class Runner {
  private ctxType: types.Type | null = null;
  private ctxPointerType: types.Type | null = null;
  private readonly httpResTypes: types.Type[] = [];
  private readonly httpReqTypes: types.Type[] = [];
  private readonly currentFact: Record<string, ResInfo> = {};
  private readonly importedFacts = new Map<types.Package, Record<string, ResInfo> | undefined>();

  constructor(private readonly pass: Pass<unknown>) {}

  run(): void {
    const result = this.pass.resultOf(buildssa);
    const prog = result.pkg?.prog ?? null;
    const ctx = requiredType(prog, "context", "Context");
    if (ctx === null) {
      return;
    }
    [this.ctxType, this.ctxPointerType] = ctx;
    const res = requiredType(prog, "net/http", "ResponseWriter");
    if (res !== null) {
      this.httpResTypes.push(res[0]);
    }
    const req = requiredType(prog, "net/http", "Request");
    if (req !== null) {
      this.httpReqTypes.push(req[1]);
    }
    const withCtx: [ssa.Function, EntryType][] = [];
    for (const fn of result.srcFuncs as ssa.Function[]) {
      const key = fn.relString(null);
      if (key in this.currentFact) {
        continue;
      }
      const entryType = this.checkIsEntry(fn);
      if (entryType === EntryType.Normal) {
        if (this.getValue(key, fn) !== undefined) {
          continue;
        }
        this.setFact(key, this.checkFuncWithoutCtx(fn, new Set([key])), fn.name());
      } else if (entryType === EntryType.WithCtx || entryType === EntryType.WithHttpHandler) {
        withCtx.push([fn, entryType]);
      }
    }
    for (const [fn, entryType] of withCtx) {
      this.checkFuncWithCtx(fn, entryType);
    }
    if (Object.keys(this.currentFact).length > 0) {
      this.pass.exportPackageFact(ctxFact, this.currentFact);
    }
  }

  private checkIsEntry(fn: ssa.Function): EntryType {
    const key = `entry:${fn.relString(null)}`;
    const known = this.getValue(key, fn);
    if (known !== undefined) {
      return known.entryType ?? EntryType.None;
    }
    const entryType = this.entryType(fn);
    this.currentFact[key] = { entryType };
    return entryType;
  }

  private entryType(fn: ssa.Function): EntryType {
    const [hasIn, hasOut] = this.checkIsCtx(fn);
    if (hasOut) {
      return EntryType.None;
    }
    if (hasIn) {
      return EntryType.WithCtx;
    }
    const [reqCtx, skip] = this.docFlags(fn);
    if (this.isHttpHandler(fn, reqCtx)) {
      return EntryType.WithHttpHandler;
    }
    return skip ? EntryType.None : EntryType.Normal;
  }

  // docFlags reads a function's doc comment: a //nolint naming contextcheck
  // skips it, and @contextcheck(req_has_ctx) marks its request as holding a
  // context.
  private docFlags(fn: ssa.Function): [boolean, boolean] {
    let reqCtx = false;
    let skip = false;
    for (const comment of this.docComments(fn)) {
      if (/^\/\/\s?nolint:/.test(comment.text) && comment.text.includes("contextcheck")) {
        skip = true;
      } else if (comment.text.startsWith("// @contextcheck(req_has_ctx)")) {
        reqCtx = true;
      }
    }
    return [reqCtx, skip];
  }

  private docComments(fn: ssa.Function): ast.Comment[] {
    const pos = fn.pos();
    const file = this.pass.files.find((f) => f!.fileStart <= pos && pos <= f!.fileEnd);
    if (file === undefined) {
      return [];
    }
    for (const decl of file!.decls) {
      if (decl?.$type === "FuncDecl" && decl.name!.pos() === pos) {
        return (decl.doc?.list ?? []) as ast.Comment[];
      }
    }
    return [];
  }

  private checkIsCtx(fn: ssa.Function): [boolean, boolean] {
    const params = tupleTypes(fn.signature!.params());
    const hasIn = params.some((t) => this.isCtxType(t)) || fn.freeVars.some((v) => this.isCtxType(v!.type()));
    const hasOut = tupleTypes(fn.signature!.results()).some((t) => this.isCtxType(t));
    return [hasIn, hasOut];
  }

  private isHttpHandler(fn: ssa.Function, reqCtx: boolean): boolean {
    const params = tupleTypes(fn.signature!.params());
    if (!params.some((t) => this.isHttpReqType(t))) {
      return false;
    }
    if (reqCtx) {
      return true;
    }
    if (tupleTypes(fn.signature!.results()).length === 0 && params.length === 2 && this.isHttpResType() && this.isHttpReqType(params[1]!)) {
      return true;
    }
    return fn.blocks.length > 0 && this.httpReqCtx(fn, true).length > 0;
  }

  // collectCtxRef finds the calls and closures that use the function's
  // context, reporting stores and phis that mix in another one.
  private collectCtxRef(fn: ssa.Function, isHttpHandler: boolean): [Set<ssa.Instruction>, boolean] {
    let ok = true;
    const refs = new Set<ssa.Instruction>();
    const checked = new Set<ssa.Value>();
    const stores = new Set<ssa.Store>();
    const phis = new Set<ssa.Phi>();
    const checkRefs = (value: ssa.Value | null, fromAddr: boolean): void => {
      const referrers = value?.referrers();
      if (value === null || referrers === null || referrers === undefined || checked.has(value)) {
        return;
      }
      checked.add(value);
      for (const instr of referrers) {
        checkInstr(instr!, fromAddr);
      }
    };
    const checkInstr = (instr: ssa.Instruction, fromAddr: boolean): void => {
      switch (instr.$type) {
        case "Call":
        case "Go":
        case "Defer":
          refs.add(instr);
          if ((this.callCtxType(instr) & ctxOut) !== 0) {
            checkRefs(instr.$type === "Call" ? instr : null, false);
          }
          break;
        case "Store":
          if (fromAddr) {
            stores.add(instr);
          } else {
            checkRefs(instr.addr, true);
          }
          break;
        case "UnOp":
          checkRefs(instr, false);
          break;
        case "MakeClosure":
          if (instr.bindings.some((binding) => this.isCtxType(binding!.type()))) {
            refs.add(instr);
          }
          break;
        case "Extract":
          if (this.isCtxType(instr.type())) {
            checkRefs(instr, false);
          }
          break;
        case "Phi":
          phis.add(instr);
          checkRefs(instr, false);
          break;
      }
    };
    if (isHttpHandler) {
      for (const value of this.httpReqCtx(fn, false)) {
        checkRefs(value, false);
      }
    } else {
      for (const value of [...fn.params, ...fn.freeVars]) {
        if (this.isCtxType(value!.type())) {
          checkRefs(value, false);
        }
      }
    }
    for (const store of stores) {
      if (!checked.has(store.val!)) {
        this.report(store, "Non-inherited new context, use function like `context.WithXXX` instead");
        ok = false;
      }
    }
    for (const phi of phis) {
      for (const edge of phi.edges) {
        if (!checked.has(edge!)) {
          this.report(phi, "Non-inherited new context, use function like `context.WithXXX` instead");
          ok = false;
        }
      }
    }
    return [refs, ok];
  }

  // httpReqCtx finds the values of r.Context() for a handler's request r.
  private httpReqCtx(fn: ssa.Function, least1: boolean): ssa.Value[] {
    const found: ssa.Value[] = [];
    const checked = new Set<ssa.Value>();
    const checkRefs = (value: ssa.Value | null, fromAddr: boolean): void => {
      const referrers = value?.referrers();
      if (value === null || referrers === null || referrers === undefined || checked.has(value)) {
        return;
      }
      checked.add(value);
      for (const instr of referrers) {
        checkInstr(instr!, fromAddr);
      }
    };
    const checkInstr = (instr: ssa.Instruction, fromAddr: boolean): void => {
      switch (instr.$type) {
        case "Call":
        case "Go":
        case "Defer": {
          if (instr.call.args.length !== 1 || (this.callCtxType(instr) & ctxOut) !== ctxOut) {
            break;
          }
          const callee = this.getFunction(instr);
          if (callee === null || callee.name() !== "Context") {
            break;
          }
          if (callee.signature!.recv() !== null && instr.$type === "Call") {
            found.push(instr);
          }
          break;
        }
        case "Store":
          if (!fromAddr) {
            checkRefs(instr.addr, true);
          }
          break;
        case "UnOp":
        case "Phi":
          checkRefs(instr, false);
          break;
      }
    };
    for (const param of fn.params) {
      if (this.isHttpReqType(param!.type())) {
        checkRefs(param, false);
        if (least1 && found.length > 0) {
          break;
        }
      }
    }
    return found;
  }

  private checkFuncWithCtx(fn: ssa.Function, entryType: EntryType): void {
    const isHttpHandler = entryType === EntryType.WithHttpHandler;
    const [refs, ok] = this.collectCtxRef(fn, isHttpHandler);
    if (!ok) {
      return;
    }
    for (const block of fn.blocks) {
      for (const instr of block!.instrs) {
        const tp = this.ctxTypeOf(instr!);
        if (tp === null || (tp & ctxOut) !== 0) {
          continue;
        }
        if ((tp & ctxIn) !== 0 && !refs.has(instr!)) {
          this.report(
            instr!,
            isHttpHandler
              ? "Non-inherited new context, use function like `context.WithXXX` or `r.Context` instead"
              : "Non-inherited new context, use function like `context.WithXXX` instead",
          );
        }
        const callee = this.getFunction(instr!);
        if (callee === null) {
          continue;
        }
        const res = this.getValue(callee.relString(null), callee);
        if (res !== undefined && !res.valid) {
          const message = `Function \`${[...(res.funcs ?? [])].reverse().join("->")}\` should pass the context parameter`;
          this.report(instr!.pos() !== token.NoPos ? instr! : callee, message);
        }
      }
    }
  }

  // checkFuncWithoutCtx reports whether a function without a context, and
  // what it calls, can do without one: false if any makes a new one.
  private checkFuncWithoutCtx(fn: ssa.Function, checking: Set<string>): boolean {
    let ok = true;
    const key = fn.relString(null);
    let set = false;
    for (const block of fn.blocks) {
      for (const instr of block!.instrs) {
        const tp = this.ctxTypeOf(instr!);
        if (tp === null || (tp & ctxOut) !== 0) {
          continue;
        }
        if ((tp & ctxIn) !== 0 && (tp & ctxInField) === 0) {
          ok = false;
        }
        const callee = this.getFunction(instr!);
        if (callee === null) {
          continue;
        }
        const calleeKey = callee.relString(null);
        const res = this.getValue(calleeKey, callee);
        if (res !== undefined) {
          if (!res.valid) {
            ok = false;
            if (!set) {
              set = true;
              this.setFact(key, false, ...(res.funcs ?? []));
            }
          }
          continue;
        }
        if (calleeKey.endsWith("$thunk") || calleeKey.endsWith("$bound")) {
          continue;
        }
        if (this.checkIsEntry(callee) !== EntryType.Normal || callee.blocks.length === 0 || checking.has(calleeKey)) {
          continue;
        }
        checking.add(calleeKey);
        const valid = this.checkFuncWithoutCtx(callee, checking);
        this.setFact(calleeKey, valid, callee.name());
        const calleeRes = this.getValue(calleeKey, callee);
        if (calleeRes !== undefined && !valid && !set) {
          set = true;
          this.setFact(key, valid, ...(calleeRes.funcs ?? []));
        }
        if (!valid) {
          ok = false;
        }
      }
    }
    return ok;
  }

  // ctxTypeOf returns how a call or closure uses contexts, or null for
  // other instructions.
  private ctxTypeOf(instr: ssa.Instruction): number | null {
    switch (instr.$type) {
      case "Call":
      case "Go":
      case "Defer":
        return this.callCtxType(instr);
      case "MakeClosure":
        return this.argsCtxType(instr.bindings);
    }
    return null;
  }

  private callCtxType(instr: ssa.Call | ssa.Go | ssa.Defer): number {
    let tp = this.argsCtxType(instr.call.args);
    if (instr.$type !== "Call") {
      return tp;
    }
    const t = instr.type();
    if (this.isCtxType(t) || (t?.$type === "Tuple" && tupleTypes(t).some((e) => this.isCtxType(e)))) {
      tp |= ctxOut;
    }
    return tp;
  }

  private argsCtxType(args: readonly (ssa.Value | null)[]): number {
    const arg = args.find((v) => this.isCtxType(v!.type()));
    if (arg === undefined) {
      return 0;
    }
    return arg!.$type === "UnOp" && arg.x?.$type === "FieldAddr" ? ctxIn | ctxInField : ctxIn;
  }

  // getFunction returns the function a static call or closure runs.
  private getFunction(instr: ssa.Instruction): ssa.Function | null {
    switch (instr.$type) {
      case "Call":
      case "Go":
      case "Defer": {
        const value = instr.call.value;
        return !instr.call.isInvoke() && value?.$type === "Function" ? value : null;
      }
      case "MakeClosure":
        return instr.fn as ssa.Function;
    }
    return null;
  }

  private isCtxType(t: types.Type | null): boolean {
    if (t?.$type === "Pointer" && t.elem()!.string() === "deferStack") {
      return false;
    }
    return types.identical(t, this.ctxType) || types.identical(t, this.ctxPointerType);
  }

  // isHttpResType reports whether net/http's ResponseWriter is known.
  // Upstream compares the type with itself, so any type passes.
  private isHttpResType(): boolean {
    return this.httpResTypes.length > 0;
  }

  private isHttpReqType(t: types.Type | null): boolean {
    return this.httpReqTypes.some((req) => types.identical(t, req));
  }

  private getValue(key: string, fn: ssa.Function): ResInfo | undefined {
    if (key in this.currentFact) {
      return this.currentFact[key];
    }
    const pkg = fn.pkg?.pkg;
    if (pkg === null || pkg === undefined) {
      return undefined;
    }
    if (!this.importedFacts.has(pkg)) {
      this.importedFacts.set(pkg, this.pass.importPackageFact(pkg, ctxFact));
    }
    return this.importedFacts.get(pkg)?.[key];
  }

  private setFact(key: string, valid: boolean, ...funcs: string[]): void {
    const names = valid ? [] : [...(this.currentFact[key]?.funcs ?? []), ...funcs];
    this.currentFact[key] = { valid, funcs: names };
  }

  // report reports at an instruction, or its function when it has no
  // position.
  private report(element: Element, message: string): void {
    let pos = element.pos();
    if (pos === token.NoPos) {
      pos = element.parent()?.pos() ?? token.NoPos;
    }
    if (pos !== token.NoPos) {
      this.pass.report({ pos, message });
    }
  }
}

// requiredType finds a named type in a package the program imports, and its
// pointer.
function requiredType(prog: ssa.Program | null, path: string, name: string): [types.Type, types.Type] | null {
  const member = prog?.importedPackage(path)?.type(name);
  const named = member?.object()?.type();
  if (named?.$type !== "Named") {
    return null;
  }
  return [named, types.newPointer(named)!];
}

function tupleTypes(tuple: types.Tuple | null): types.Type[] {
  const result: types.Type[] = [];
  for (let i = 0; i < (tuple?.len() ?? 0); i++) {
    result.push(tuple!.at(i)!.type()!);
  }
  return result;
}
