import * as ast from "go/ast";
import * as constant from "go/constant";
import * as token from "go/token";
import * as types from "go/types";
import type * as ssa from "golang.org/x/tools/go/ssa";
import * as os from "os";
import * as filepath from "path/filepath";
import { defineAnalyzer, formatNode, type Pass } from "tsk";
import { buildssa } from "tsk/passes";

interface Config {
  /** Also check exported functions. */
  checkExported: boolean;
}

export default defineAnalyzer<Config>({
  name: "unparam",
  doc: "Reports unused function parameters",
  url: "https://github.com/mvdan/unparam",
  requires: [buildssa],
  config: { checkExported: false },
  run(pass) {
    const prog = pass.resultOf(buildssa).pkg!.prog!;
    for (const issue of new Checker(pass, prog).check()) {
      pass.report({ pos: issue.pos, message: issue.message });
    }
  },
});

interface Issue {
  pos: token.Pos;
  message: string;
}

const harmlessCall = /\b(log(ger)?|errors)\b|\bf?print|errorf?$/i;
const stdSizes = types.sizesFor("gc", "amd64")!;
const errorType = types.Universe!.lookup("error")!.type();

// storeKinds describes the places a stored function escapes to.
const storeKinds = new Map([
  ["FieldAddr", "field"],
  ["IndexAddr", "element"],
  ["Global", "global"],
]);

class Checker {
  private readonly issues: Issue[] = [];
  private readonly callByPos = new Map<token.Pos, ast.CallExpr>();
  private readonly funcBodyByPos = new Map<token.Pos, ast.BlockStmt | null>();
  // typesImplementing records the methods each named type needs to
  // implement interfaces.
  private readonly typesImplementing = new Map<types.Named, Set<string>>();
  private readonly linknamed = new Set<token.Pos>();
  private readonly localCallSites = new Map<ssa.Function, ssa.Instruction[]>();
  // These record whether a function's whole signature cannot change, or
  // only its parameters or results, and why.
  private readonly signRequiredBy = new Map<ssa.Function, string>();
  private readonly paramsRequiredBy = new Map<ssa.Function, string>();
  private readonly resultsRequiredBy = new Map<ssa.Function, string>();
  private readonly declCountCache = new Map<string, Map<string, number>>();

  constructor(
    private readonly pass: Pass<Config>,
    private readonly prog: ssa.Program,
  ) {}

  check(): Issue[] {
    const pass = this.pass;
    const genFiles = new Set<string>();
    for (const file of pass.files) {
      const first = file!.comments[0];
      if (first && isGeneratedDoc(first.text())) {
        genFiles.add(pass.fset.position(file!.pos()).filename);
      }
      ast.inspect(file, (node) => {
        switch (node?.$type) {
          case "ValueSpec": {
            // var _ someIface = named
            if (node.values.length === 0 || node.type === null || node.names.length !== 1 || node.names[0]!.name !== "_") {
              break;
            }
            const iface = pass.typesInfo.typeOf(node.type)?.underlying();
            if (iface?.$type === "Interface") {
              this.addImplementing(findNamed(pass.typesInfo.types.get(node.values[0]!)?.type ?? null), iface);
            }
            break;
          }
          case "CallExpr":
            this.callByPos.set(node.lparen, node);
            break;
          case "FuncDecl":
            // ssa.Function.Pos is the position of a FuncDecl's name.
            this.funcBodyByPos.set(node.name!.pos(), node.body);
            if (node.doc?.list.some((c) => c!.text.startsWith("//go:linkname "))) {
              this.linknamed.add(node.name!.pos());
            }
            break;
          case "FuncLit":
            this.funcBodyByPos.set(node.pos(), node.body);
            break;
        }
        return true;
      });
    }
    const allFuncs = allFunctions(this.prog, pass.pkg);
    // AllFunctions skips methods of unexported types unless reachable, so add
    // every source function too.
    const addSrcFunc = (fn: ssa.Function) => {
      allFuncs.add(fn);
      for (const anon of fn.anonFuncs) {
        addSrcFunc(anon!);
      }
    };
    for (const def of pass.typesInfo.defs.values()) {
      const fn = def?.$type === "Func" ? this.prog.funcValue(def) : null;
      if (fn !== null) {
        addSrcFunc(fn);
      }
    }
    const freeVars = closureFreeVars(allFuncs);
    for (const fn of allFuncs) {
      // Synthetic func wrappers are uninteresting and lead to false negatives.
      if (!fn.synthetic.startsWith("wrapper for func")) {
        this.recordRequirements(fn, freeVars);
      }
    }
    const pkgName = pass.pkg.name();
    for (const fn of allFuncs) {
      if (fn.pkg === null || fn.name() === "init" || fn.blocks.length === 0 || fn.pkg.pkg !== pass.pkg) {
        continue;
      }
      // Exported functions are skipped, but not closures within them, or
      // anything in a main package.
      if (!this.pass.config.checkExported && pkgName !== "main" && !fn.name().includes("$") && token.isExported(fn.name())) {
        continue;
      }
      if (genFiles.has(pass.fset.position(fn.pos()).filename)) {
        continue;
      }
      this.checkFunc(fn);
    }
    return this.issues;
  }

  private addImplementing(named: types.Named | null, iface: types.Interface): void {
    if (named === null) {
      return;
    }
    const names = this.typesImplementing.get(named) ?? new Set();
    for (let i = 0; i < iface.numMethods(); i++) {
      names.add(iface.method(i)!.name());
    }
    this.typesImplementing.set(named, names);
  }

  // recordRequirements records the call sites in a function, and the uses
  // of functions as values, which fix their signatures.
  private recordRequirements(curFunc: ssa.Function, freeVars: Map<ssa.FreeVar, ssa.Function>): void {
    const find = (v: ssa.Value | null) => findFunction(freeVars, v);
    for (const block of curFunc.blocks) {
      for (const instr of block!.instrs) {
        if (instr?.$type === "Call" || instr?.$type === "Go" || instr?.$type === "Defer") {
          const callee = find(instr.call.value);
          if (callee !== null) {
            this.localCallSites.set(callee, [...(this.localCallSites.get(callee) ?? []), instr]);
          }
          const forwarded = receivesExtractedArgs(freeVars, instr);
          if (forwarded !== null) {
            // fn(someFunc()) fixes params
            this.paramsRequiredBy.set(forwarded, "forwarded call");
          }
          for (const arg of instr.call.args) {
            const fn = find(arg);
            if (fn !== null) {
              // someFunc(fn), also via go or defer
              this.signRequiredBy.set(fn, "call");
            }
          }
        }
        switch (instr?.$type) {
          case "Phi":
            for (const edge of instr.edges) {
              this.requireSign(find(edge), "phi");
            }
            break;
          case "Return": {
            const results = returnValues(instr);
            for (const value of results) {
              this.requireSign(find(value), "result");
            }
            const call = callExtract(instr, results);
            const fn = call === null ? null : find(call.call.value);
            if (fn !== null) {
              // return fn()
              this.resultsRequiredBy.set(fn, "return");
            }
            break;
          }
          case "Store": {
            const as = storeKinds.get(instr.addr?.$type ?? "");
            if (as !== undefined) {
              this.requireSign(find(instr.val), as);
            }
            break;
          }
          case "MapUpdate":
            this.requireSign(find(instr.value), "map value");
            break;
          case "Send":
            this.requireSign(find(instr.x), "channel send");
            break;
          case "Select":
            for (const state of instr.states) {
              if (state!.dir === types.SendOnly) {
                this.requireSign(find(state!.send), "channel send");
              }
            }
            break;
          case "MakeInterface": {
            // someIface(named)
            const iface = instr.type()?.underlying();
            if (iface?.$type === "Interface") {
              this.addImplementing(findNamed(instr.x!.type()), iface);
            }
            this.requireSign(find(instr.x), "interface");
            break;
          }
          case "ChangeType":
            this.requireSign(find(instr.x), "type conversion");
            break;
        }
      }
    }
  }

  private requireSign(fn: ssa.Function | null, by: string): void {
    if (fn !== null) {
      this.signRequiredBy.set(fn, by);
    }
  }

  private addIssue(fn: ssa.Function, pos: token.Pos, message: string): void {
    this.issues.push({ pos, message: `${fn.relString(fn.pkg?.pkg ?? null)} - ${message}` });
  }

  private checkFunc(fn: ssa.Function): void {
    if (dummyImpl(fn.blocks[0]!) || this.signRequiredBy.has(fn) || this.linknamed.has(fn.pos())) {
      return;
    }
    const recv = fn.signature!.recv();
    if (recv !== null) {
      const named = findNamed(recv.type());
      if (named !== null && this.typesImplementing.get(named)?.has(fn.name())) {
        return;
      }
    }
    if (this.multipleImpls(fn)) {
      return;
    }
    const resultsBy = this.resultsRequiredBy.has(fn);
    const callSites = this.localCallSites.get(fn) ?? [];
    const results = fn.signature!.results();
    const nresults = results?.len() ?? 0;
    const sameConsts: (ssa.Const | null)[] = Array(nresults).fill(null);
    let numRets = 0;
    let allRetsExtracting = true;
    for (const block of fn.blocks) {
      // Returns of a function whose results are required cannot change.
      const last = block!.instrs[block!.instrs.length - 1];
      if (resultsBy || last?.$type !== "Return") {
        continue;
      }
      last.results.forEach((value, i) => {
        if (value?.$type !== "Extract") {
          allRetsExtracting = false;
        }
        const cnst = constValue(value);
        if (numRets === 0) {
          sameConsts[i] = cnst;
        } else if (!eqlConsts(sameConsts[i], cnst)) {
          sameConsts[i] = null;
        }
      });
      numRets++;
    }
    sameConsts.forEach((cnst, i) => {
      // One return of a non-nil constant gives too many false positives.
      if (cnst === null || (cnst.value !== null && numRets === 1)) {
        return;
      }
      const res = results!.at(i)!;
      this.addIssue(fn, res.pos(), `result ${paramDesc(i, res)} is always ${constValueString(cnst)}`);
    });
    for (let i = 0; i < nresults && !resultsBy && !allRetsExtracting; i++) {
      const res = results!.at(i)!;
      // An unused error is errcheck's business.
      if (types.unalias(res.type()) === errorType || !this.resultIgnored(callSites, i)) {
        continue;
      }
      this.addIssue(fn, res.pos(), `result ${paramDesc(i, res)} is never used`);
    }
    if (this.paramsRequiredBy.has(fn)) {
      return;
    }
    fn.params.forEach((par, i) => {
      // Skip the receiver, and unnamed or underscored parameters.
      if ((i === 0 && recv !== null) || /^(_|$)/.test(par!.object()!.name())) {
        return;
      }
      const t = par!.type();
      if (!containsTypeParam(t) && stdSizes.sizeof(t) === 0) {
        return;
      }
      const constStr = this.alwaysReceivedConst(callSites, par!, i);
      if (constStr === "" && this.anyRealUse(par!, i)) {
        return;
      }
      this.addIssue(fn, par!.pos(), `${par!.name()} ${constStr === "" ? "is unused" : `always receives ${constStr}`}`);
    });
  }

  // resultIgnored reports whether at least two call sites, and all of them,
  // ignore result i.
  private resultIgnored(callSites: ssa.Instruction[], i: number): boolean {
    let count = 0;
    for (const site of callSites) {
      if (site.$type !== "Call") {
        // e.g. a go statement
        count++;
        continue;
      }
      for (const ref of site.referrers() ?? []) {
        if (ref?.$type !== "Extract") {
          return false;
        }
        if (ref.index === i && (ref.referrers() ?? []).length > 0) {
          return false;
        }
      }
      count++;
    }
    return count >= 2;
  }

  // alwaysReceivedConst describes the constant a parameter receives at
  // every one of at least four call sites, or returns "".
  private alwaysReceivedConst(callSites: ssa.Instruction[], par: ssa.Parameter, pos: number): string {
    if (callSites.length < 4 || token.isExported(par.parent()!.name())) {
      return "";
    }
    // go/ast's CallExpr.Args omits the receiver, which go/ssa's includes.
    const origPos = par.parent()!.signature!.recv() !== null ? pos - 1 : pos;
    let seen: ssa.Const | null = null;
    let seenOrig = "";
    for (const site of callSites) {
      const call = (site as ssa.Call).call;
      if (pos >= call.args.length) {
        return "";
      }
      const cnst = constValue(call.args[pos]);
      if (cnst === null) {
        return "";
      }
      const origCall = this.callByPos.get(call.pos());
      // A variadic parameter may not be given.
      const origArg = origCall !== undefined && origPos < origCall.args.length ? formatNode(origCall.args[origPos]!) : "";
      if (seen === null) {
        seen = cnst;
        seenOrig = origArg;
      } else if (!eqlConsts(seen, cnst)) {
        return "";
      } else if (origArg !== seenOrig) {
        seenOrig = "";
      }
    }
    const seenStr = constValueString(seen!);
    return seenOrig !== "" && seenStr !== seenOrig ? `${seenOrig} (${seenStr})` : seenStr;
  }

  // anyRealUse reports whether a parameter is used in its function, other
  // than passed as itself in a recursive call.
  private anyRealUse(par: ssa.Parameter, pos: number): boolean {
    const refs = par.referrers() ?? [];
    if (refs.length === 0) {
      // "_ = par" keeps a parameter deliberately, but SSA drops it.
      let found = false;
      const body = this.funcBodyByPos.get(par.parent()!.pos());
      if (body) {
        ast.inspect(body, (node) => {
          if (found) {
            return false;
          }
          if (node?.$type !== "AssignStmt" || node.tok !== token.ASSIGN || node.lhs.length !== 1 || node.rhs.length !== 1) {
            return true;
          }
          const [left, right] = [node.lhs[0], node.rhs[0]];
          if (left?.$type === "Ident" && left.name === "_" && right?.$type === "Ident") {
            const object = this.pass.typesInfo.uses.get(right);
            found = object !== undefined && object !== null && object.pos() === par.pos();
          }
          return true;
        });
      }
      return found;
    }
    for (const ref of refs) {
      if (ref?.$type === "Call") {
        if (ref.call.value !== par.parent()) {
          return true;
        }
        // A recursive call passing the parameter in its own place is no use.
        if (!ref.call.args.some((arg, i) => arg === par && i === pos)) {
          return true;
        }
      } else if (!(ref?.$type === "Store" && insertedStore(ref))) {
        return true;
      }
    }
    return false;
  }

  // multipleImpls reports whether a function is declared more than once in
  // its package's directory, as for different build tags.
  private multipleImpls(fn: ssa.Function): boolean {
    if (fn.parent() !== null) {
      return false;
    }
    const dir = filepath.dir(this.pass.fset.position(fn.pos()).filename);
    let name = fn.name();
    const recv = fn.signature!.recv();
    if (recv !== null) {
      name = `${findNamed(recv.type())?.obj()?.name()}.${name}`;
    }
    return (this.declCounts(dir, this.pass.pkg.name()).get(name) ?? 0) > 1;
  }

  // declCounts counts each function declared in a directory's files of a
  // package, whatever their build tags. Upstream parses the files; scanning
  // their lines for declarations is close enough.
  private declCounts(dir: string, pkgName: string): Map<string, number> {
    const key = `${dir}:${pkgName}`;
    const cached = this.declCountCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const counts = new Map<string, number>();
    let entries: ReturnType<typeof os.readDir> = [];
    try {
      entries = os.readDir(dir);
    } catch {
      // Upstream also ignores directories it cannot read.
    }
    for (const entry of entries) {
      if (entry!.isDir() || !entry!.name().endsWith(".go")) {
        continue;
      }
      const source = os.readFile(filepath.join(dir, entry!.name()));
      if (/^package\s+(\w+)/m.exec(source)?.[1] !== pkgName) {
        continue;
      }
      for (const match of source.matchAll(/^func\s*(?:\(([^)]*)\))?\s*(\w+)/gm)) {
        const declName = match[1] === undefined ? match[2] : `${receiverTypeName(match[1])}.${match[2]}`;
        counts.set(declName, (counts.get(declName) ?? 0) + 1);
      }
    }
    this.declCountCache.set(key, counts);
    return counts;
  }
}

// receiverTypeName returns a receiver's base type name, as T in "t *T[K]".
function receiverTypeName(recv: string): string {
  const fields = recv
    .replace(/\[.*\]/, "")
    .trim()
    .split(/\s+/);
  return fields[fields.length - 1].replace(/[*()]/g, "");
}

function isGeneratedDoc(text: string): boolean {
  return text.includes("Code generated") || text.includes("DO NOT EDIT");
}

// allFunctions ports ssautil.AllFunctions: every function reachable from
// package members, methods of exported types built from source, and runtime
// types.
function allFunctions(prog: ssa.Program, srcPkg: types.Package): Set<ssa.Function> {
  const seen = new Set<ssa.Function>();
  const visit = (fn: ssa.Function | null) => {
    if (fn === null || seen.has(fn)) {
      return;
    }
    seen.add(fn);
    for (const block of fn.blocks) {
      for (const instr of block!.instrs) {
        for (const op of instr!.operands([])) {
          if (op?.$type === "Function") {
            visit(op);
          }
        }
      }
    }
  };
  const methodsOf = (t: types.Type | null) => {
    if (types.isInterface(t)) {
      return;
    }
    const mset = prog.methodSets.methodSet(t)!;
    for (let i = 0; i < mset.len(); i++) {
      const sel = mset.at(i)!;
      const fn = sel.obj();
      // Generic methods are skipped.
      if (fn?.$type === "Func" && fn.signature()?.typeParams() === null) {
        visit(prog.methodValue(sel));
      }
    }
  };
  for (const pkg of prog.allPackages()) {
    for (const member of pkg!.members.values()) {
      if (member?.$type === "Function") {
        visit(member);
      } else if (member?.$type === "Type") {
        // Methods of exported, non-generic named types from source.
        const t = member.type();
        if (pkg!.pkg === srcPkg && token.isExported(member.name()) && !types.isInterface(t) && t?.$type === "Named" && t.typeParams() === null) {
          methodsOf(t);
          methodsOf(types.newPointer(t));
        }
      }
    }
  }
  for (const t of prog.runtimeTypes()) {
    methodsOf(t);
  }
  return seen;
}

// closureFreeVars maps free variables of closures to the function literal
// they hold, in the simple cases.
function closureFreeVars(funcs: Set<ssa.Function>): Map<ssa.FreeVar, ssa.Function> {
  const freeVars = new Map<ssa.FreeVar, ssa.Function>();
  for (const fn of funcs) {
    for (const block of fn.blocks) {
      for (const instr of block!.instrs) {
        if (instr?.$type !== "MakeClosure" || instr.fn?.$type !== "Function") {
          continue;
        }
        instr.fn.freeVars.forEach((fv, i) => {
          const binding = instr.bindings[i];
          if (binding?.$type !== "Alloc") {
            return;
          }
          for (const ref of binding.referrers() ?? []) {
            if (ref?.$type === "Store" && ref.val?.$type === "Function") {
              freeVars.set(fv!, ref.val);
              break;
            }
          }
        });
      }
    }
  }
  return freeVars;
}

function findNamed(t: types.Type | null): types.Named | null {
  const u = types.unalias(t);
  if (u?.$type === "Pointer") {
    return findNamed(u.elem());
  }
  // The generic origin maps instantiations and G's methods to one key.
  return u?.$type === "Named" ? u.origin() : null;
}

// findFunction returns the function behind a value, if any.
function findFunction(freeVars: Map<ssa.FreeVar, ssa.Function>, value: ssa.Value | null): ssa.Function | null {
  switch (value?.$type) {
    case "Function": {
      const name = value.name();
      if (!name.endsWith("$thunk") && !name.endsWith("$bound")) {
        return value;
      }
      // Method wrappers call the wrapped function in their single block.
      for (const instr of value.blocks[0]!.instrs) {
        const callee = instr?.$type === "Call" ? instr.call.staticCallee() : null;
        if (callee) {
          return callee;
        }
      }
      return null;
    }
    case "MakeClosure":
      return findFunction(freeVars, value.fn);
    case "UnOp":
      return value.op === token.MUL && value.x?.$type === "FreeVar" ? (freeVars.get(value.x) ?? null) : null;
    default:
      return null;
  }
}

function constValue(value: ssa.Value | null): ssa.Const | null {
  if (value?.$type === "Const") {
    return value;
  }
  return value?.$type === "MakeInterface" ? constValue(value.x) : null;
}

function eqlConsts(c1: ssa.Const | null, c2: ssa.Const | null): boolean {
  if (c1 === null || c2 === null) {
    return c1 === c2;
  }
  if (!types.identical(c1.type(), c2.type())) {
    return false;
  }
  if (c1.value === null || c2.value === null) {
    return c1.value === c2.value;
  }
  return constant.compare(c1.value, token.EQL, c2.value);
}

function constValueString(cnst: ssa.Const): string {
  return cnst.value === null ? "nil" : cnst.value.string();
}

function paramDesc(i: number, v: types.Var): string {
  const name = v.name();
  return name !== "" && name !== "_" ? name : `${i} (${v.type()!.string()})`;
}

// containsTypeParam reports whether a type's size depends on a type
// parameter.
function containsTypeParam(t: types.Type | null): boolean {
  const u = types.unalias(t);
  switch (u?.$type) {
    case "TypeParam":
    case "Union":
      return true;
    case "Struct":
      return [...Array(u.numFields()).keys()].some((i) => containsTypeParam(u.field(i)!.type()));
    case "Array":
      return containsTypeParam(u.elem());
    case "Named":
      return containsTypeParam(u.underlying());
    default:
      return false;
  }
}

// insertedStore reports whether an instruction is a store go/ssa inserted
// rather than translated from source.
function insertedStore(instr: ssa.Instruction): boolean {
  if (instr.pos() !== token.NoPos || instr.$type !== "Store") {
    return false;
  }
  return instr.addr?.$type === "Alloc" && (instr.addr.referrers() ?? []).length === 1;
}

// dummyImpl reports whether a block almost immediately panics, throws, or
// returns constants only.
function dummyImpl(block: ssa.BasicBlock): boolean {
  const harmless = (call: ssa.Call) => harmlessCall.test(call.call.value!.string());
  for (const instr of block.instrs) {
    if (insertedStore(instr!)) {
      continue;
    }
    for (const op of instr!.operands([])) {
      switch (op?.$type) {
        case undefined:
        case "Const":
        case "ChangeType":
        case "Alloc":
        case "MakeInterface":
        case "MakeMap":
        case "Function":
        case "Global":
        case "IndexAddr":
        case "Slice":
        case "UnOp":
        case "Parameter":
          break;
        case "Call":
          if (!harmless(op)) {
            return false;
          }
          break;
        default:
          return false;
      }
    }
    switch (instr!.$type) {
      case "Alloc":
      case "Store":
      case "UnOp":
      case "BinOp":
      case "MakeInterface":
      case "MakeMap":
      case "Extract":
      case "IndexAddr":
      case "FieldAddr":
      case "Slice":
      case "Lookup":
      case "ChangeType":
      case "TypeAssert":
      case "Convert":
      case "ChangeInterface":
        // Non-trivial expressions in panic, log, or print calls.
        break;
      case "Return":
      case "Panic":
        return true;
      case "Call":
        if (harmless(instr as ssa.Call)) {
          break;
        }
        // throw is the runtime's panic.
        return (instr as ssa.Call).call.value!.name() === "throw";
      default:
        return false;
    }
  }
  return false;
}

// receivesExtractedArgs returns the function a call invokes as fn(g()),
// with several parameters all from one call.
function receivesExtractedArgs(freeVars: Map<ssa.FreeVar, ssa.Function>, call: ssa.Call | ssa.Go | ssa.Defer): ssa.Function | null {
  const callee = findFunction(freeVars, call.call.value);
  if (callee === null || (callee.signature!.params()?.len() ?? 0) < 2) {
    return null;
  }
  const args = callee.signature!.recv() !== null ? call.call.args.slice(1) : call.call.args;
  return callExtract(call, args) !== null ? callee : null;
}

// returnValues returns a return's values, seeing through the stores and
// loads go/ssa adds around deferred calls.
function returnValues(ret: ssa.Return): (ssa.Value | null)[] {
  return ret.results.map((value) => storedValue(ret.block()!, value) ?? value);
}

function storedValue(block: ssa.BasicBlock, value: ssa.Value | null): ssa.Value | null {
  if (value?.$type !== "UnOp" || value.op !== token.MUL || value.x?.$type !== "Alloc") {
    return null;
  }
  let stored: ssa.Value | null = null;
  for (const instr of block.instrs) {
    if (instr?.$type === "Store" && instr.addr === value.x) {
      stored = instr.val;
    }
  }
  return stored;
}

// callExtract returns the call fn(...) whose results are passed directly to
// the parent, as in fn2(fn(...)) or return fn(...).
function callExtract(parent: ssa.Instruction, values: (ssa.Value | null)[]): ssa.Call | null {
  if (values.length === 1 && values[0]?.$type === "Call") {
    return values[0];
  }
  let prev: ssa.Call | null = null;
  for (let i = 0; i < values.length; i++) {
    const ext = values[i];
    if (ext?.$type !== "Extract" || ext.index !== i || ext.tuple?.$type !== "Call") {
      return null;
    }
    if (prev === null) {
      prev = ext.tuple;
    } else if (prev !== ext.tuple) {
      return null;
    }
  }
  // As in "a, b := fn(); fn2(a, b)", earlier calls do not count.
  if (prev === null || (prev.call.signature()!.results()?.len() ?? 0) !== values.length || prev.pos() < parent.pos()) {
    return null;
  }
  return prev;
}
