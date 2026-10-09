import type * as ast from "go/ast";
import * as types from "go/types";
import type * as ssa from "golang.org/x/tools/go/ssa";
import * as os from "os";
import { defineAnalyzer, type Pass } from "tsk";
import { buildssa } from "tsk/passes";

interface Config {
  /** Also require the body to be consumed, as by io.Copy or io.ReadAll. */
  checkConsumption: boolean;
}

const handledDirective = "bodyclose:handled";

// nonValues are the instructions that are not also ssa.Values.
const nonValues = new Set(["DebugRef", "Defer", "Go", "If", "Jump", "MapUpdate", "Panic", "Return", "RunDefers", "Send", "Store"]);

export default defineAnalyzer<Config>({
  name: "bodyclose",
  doc: `check whether HTTP response bodies are closed

An unclosed response body leaks the connection. A function whose doc comment
holds //bodyclose:handled takes over responsibility for responses passed to it.`,
  requires: [buildssa],
  config: { checkConsumption: false },
  run(pass) {
    const response = pass.pkg
      .imports()
      .find((pkg) => pkg!.path() === "net/http")
      ?.scope()
      ?.lookup("Response");
    if (response == null) {
      return;
    }
    const checker = new Checker(pass, response);
    for (const fn of pass.resultOf(buildssa).srcFuncs) {
      // A function returning a response hands closing it to its caller.
      const results = fn!.signature!.results();
      if ([...Array(results?.len() ?? 0).keys()].some((i) => results!.at(i)!.type()!.string() === checker.responseType)) {
        continue;
      }
      for (const block of fn!.blocks) {
        block!.instrs.forEach((instr, i) => {
          if (checker.isOpen(block!, i)) {
            const message = pass.config.checkConsumption ? "response body must be closed and consumed" : "response body must be closed";
            pass.report({ pos: instr!.pos(), message });
          }
        });
      }
    }
  },
});

class Checker {
  readonly responseType: string;
  private readonly bodyType: types.Type;
  private readonly closeName: string;
  private readonly skipFile = new Map<ast.File, boolean>();
  private readonly handledLines = new Map<string, Set<number>>();

  constructor(
    private readonly pass: Pass<Config>,
    response: types.Object,
  ) {
    this.responseType = types.newPointer(response.type())!.string();
    const struct = response.type()!.underlying() as types.Struct;
    const body = [...Array(struct.numFields()).keys()].map((i) => struct.field(i)!).find((field) => field.id() === "Body")!;
    this.bodyType = body.type()!;
    const bodyInterface = this.bodyType.underlying() as types.Interface;
    this.closeName = [...Array(bodyInterface.numMethods()).keys()]
      .map((i) => bodyInterface.method(i)!)
      .find((method) => method.id() === "Close")!
      .name();
  }

  isOpen(block: ssa.BasicBlock, i: number): boolean {
    const call = this.requestCall(block.instrs[i]);
    if (call === null || this.handledByDirective(call)) {
      return false;
    }
    if (call.referrers().length === 0) {
      return true;
    }
    // httptest.ResponseRecorder's bodies need no closing.
    const callee = call.call.staticCallee();
    if (
      callee?.name() === "Result" &&
      callee.pkg?.pkg?.name() === "httptest" &&
      callee.signature?.recv()?.type()?.string() === "*net/http/httptest.ResponseRecorder"
    ) {
      return false;
    }
    for (const callRef of call.referrers()) {
      const value = this.responseValue(callRef);
      if (value === null) {
        continue;
      }
      if (value.referrers().length === 0) {
        return true;
      }
      for (const ref of value.referrers()) {
        switch (ref?.$type) {
          case "Store": {
            // A response stored in a closure's variable or a global.
            if (ref.addr?.$type === "Global") {
              return false;
            }
            const addrRefs = ref.addr!.referrers();
            if (addrRefs.length === 0) {
              return true;
            }
            for (const addrRef of addrRefs) {
              if (addrRef?.$type === "MakeClosure") {
                const fn = addrRef.fn as ssa.Function;
                if (this.noImportedNetHTTP(fn)) {
                  return false;
                }
                return this.calledInFunc(fn, isClosureCalled(addrRef));
              }
              // Closed through a struct field or method.
              if (addrRef?.$type === "Store" && addrRef.addr?.$type === "FieldAddr") {
                for (const instr of addrRef.addr.block()!.instrs) {
                  const bodyOp = this.bodyOp(instr);
                  if (bodyOp?.referrers().some((closeRef) => this.isCloseCall(closeRef))) {
                    return false;
                  }
                }
              }
            }
            break;
          }
          case "Call":
          case "Defer": {
            // The response is passed to a function that may close it.
            const fn = ref.call.value;
            if (fn?.$type === "Function") {
              for (const fnBlock of fn.blocks) {
                for (let j = 0; j < fnBlock!.instrs.length; j++) {
                  if (this.isCloseCall(fnBlock!.instrs[j])) {
                    return false;
                  }
                  if (this.isOpen(fnBlock!, j)) {
                    return true;
                  }
                }
              }
            }
            break;
          }
          case "FieldAddr": {
            const verdict = this.checkBodyRefs(ref.referrers());
            if (verdict !== undefined) {
              return verdict;
            }
            break;
          }
          case "Phi":
            // The response flows in from several blocks.
            for (const phiRef of ref.referrers()) {
              if (phiRef?.$type === "FieldAddr") {
                const verdict = this.checkBodyRefs(phiRef.referrers());
                if (verdict !== undefined) {
                  return verdict;
                }
              }
            }
            break;
        }
      }
    }
    return true;
  }

  // checkBodyRefs reports whether loads of the body leave it open, or
  // undefined when none decides.
  private checkBodyRefs(refs: (ssa.Instruction | null)[]): boolean | undefined {
    for (const ref of refs) {
      const bodyOp = this.bodyOp(ref);
      if (bodyOp === null) {
        continue;
      }
      if (bodyOp.referrers().length === 0) {
        return true;
      }
      if (this.isBodyProperlyHandled(bodyOp)) {
        return false;
      }
    }
    return undefined;
  }

  private handledByDirective(call: ssa.Call): boolean {
    const fn = call.call.staticCallee()?.object();
    if (fn?.$type !== "Func") {
      return false;
    }
    const position = this.pass.fset.positionFor(fn.pos(), false);
    if (!position.isValid() || position.filename === "") {
      return false;
    }
    let lines = this.handledLines.get(position.filename);
    if (lines === undefined) {
      lines = handledDirectiveLines(position.filename);
      this.handledLines.set(position.filename, lines);
    }
    return lines.has(position.line);
  }

  private requestCall(instr: ssa.Instruction | null): ssa.Call | null {
    if (instr?.$type !== "Call") {
      return null;
    }
    const callType = typeString(instr.type());
    return callType.includes(this.responseType) && !callType.includes("net/http.ResponseController") ? instr : null;
  }

  private responseValue(instr: ssa.Instruction | null): ssa.Value | null {
    if (instr === null) {
      return null;
    }
    if (instr.$type === "FieldAddr") {
      return instr.x!.type()!.string() === this.responseType ? instr.x : null;
    }
    if (instr.$type === "Store") {
      return instr.val!.type()!.string() === this.responseType ? instr.val : null;
    }
    if (!nonValues.has(instr.$type)) {
      const value = instr as ssa.Value;
      return typeString(value.type()) === this.responseType ? value : null;
    }
    return null;
  }

  private bodyOp(instr: ssa.Instruction | null): ssa.UnOp | null {
    return instr?.$type === "UnOp" && instr.type() === this.bodyType ? instr : null;
  }

  private isBodyProperlyHandled(bodyOp: ssa.UnOp): boolean {
    if (!bodyOp.referrers().some((ref) => this.isCloseCall(ref))) {
      return false;
    }
    return !this.pass.config.checkConsumption || hasConsumption(bodyOp);
  }

  private isCloseCall(instr: ssa.Instruction | null): boolean {
    switch (instr?.$type) {
      case "Defer":
      case "Call":
        return instr.call.method?.name() === this.closeName;
      case "ChangeInterface": {
        if (instr.type()!.string() !== "io.Closer") {
          return false;
        }
        const closeMethod = (instr.type()!.underlying() as types.Interface).method(0);
        for (const ref of instr.referrers()) {
          if (ref?.$type === "Defer") {
            const fn = ref.common()!.value;
            if (fn?.$type === "Function" && fn.blocks.some((block) => block!.instrs.some((i) => i?.$type === "Call" && i.call.method === closeMethod))) {
              return true;
            }
          }
          if (ref?.$type === "Return" && ref.results.some((result) => result!.type()!.string() === "io.Closer")) {
            return true;
          }
        }
        return false;
      }
      case "Return":
        return instr.results.some((result) => result!.type()!.string() === "io.ReadCloser");
    }
    return false;
  }

  private noImportedNetHTTP(fn: ssa.Function): boolean {
    const object = fn.object();
    if (object === null) {
      return false;
    }
    const file = this.pass.files.find((f) => f.pos() <= object.pos() && object.pos() <= f.end());
    if (file === undefined) {
      return false;
    }
    let skip = this.skipFile.get(file);
    if (skip === undefined) {
      skip = !file.imports.some((spec) => removeVendor(JSON.parse(spec!.path!.value)) === "net/http");
      this.skipFile.set(file, skip);
    }
    return skip;
  }

  private calledInFunc(fn: ssa.Function, called: boolean): boolean {
    for (const block of fn.blocks) {
      for (let i = 0; i < block!.instrs.length; i++) {
        const instr = block!.instrs[i]!;
        if (instr.$type !== "UnOp") {
          return this.isOpen(block!, i) || !called;
        }
        const refs = instr.referrers();
        if (refs.length === 0) {
          return true;
        }
        for (const ref of refs) {
          if (ref === null || nonValues.has(ref.$type)) {
            continue;
          }
          const value = ref as ssa.Value;
          const pointer = value.type();
          if (pointer?.$type !== "Pointer" || !isNamedType(pointer.elem(), "io", "ReadCloser")) {
            continue;
          }
          for (const valueRef of value.referrers()) {
            if (valueRef?.$type !== "UnOp") {
              continue;
            }
            const loadRefs = valueRef.referrers();
            if (loadRefs.length === 0) {
              return true;
            }
            for (const loadRef of loadRefs) {
              if (loadRef?.$type === "Call" && loadRef.call.method?.name() === "Close") {
                return !called;
              }
            }
          }
        }
      }
    }
    return false;
  }
}

// handledDirectiveLines returns the lines of function names whose doc comment
// holds the directive. The doc comment is the run of // lines above the func.
function handledDirectiveLines(filename: string): Set<number> {
  const lines = new Set<number>();
  let source: string;
  try {
    source = os.readFile(filename);
  } catch {
    return lines;
  }
  const text = source.split("\n");
  text.forEach((line, i) => {
    if (!line.startsWith("func ")) {
      return;
    }
    for (let j = i - 1; j >= 0 && text[j].trimStart().startsWith("//"); j--) {
      if (text[j].trim().slice(2).trim() === handledDirective) {
        lines.add(i + 1);
        return;
      }
    }
  });
  return lines;
}

// hasConsumption reports whether the body's function passes it to a known
// consumer, such as io.ReadAll.
function hasConsumption(bodyOp: ssa.UnOp): boolean {
  const bodyAddr = bodyOp.x;
  if (bodyAddr?.$type !== "FieldAddr") {
    return false;
  }
  for (const block of bodyOp.block()!.parent()!.blocks) {
    for (const instr of block!.instrs) {
      if (instr?.$type === "Call" && isConsumer(instr) && instr.call.args.some((arg) => isBody(arg, bodyAddr))) {
        return true;
      }
    }
  }
  return false;
}

function isConsumer(call: ssa.Call): boolean {
  const callee = call.call.staticCallee();
  const pkg = callee?.pkg?.pkg?.path();
  const name = callee?.name();
  return (
    (pkg === "io" && (name === "Copy" || name === "ReadAll")) ||
    (pkg === "io/ioutil" && name === "ReadAll") ||
    (pkg === "encoding/json" && name === "NewDecoder") ||
    (pkg === "bufio" && (name === "NewScanner" || name === "NewReader"))
  );
}

function isBody(arg: ssa.Value | null, bodyAddr: ssa.FieldAddr): boolean {
  const sameField = (addr: ssa.Value | null) => addr?.$type === "FieldAddr" && addr.x === bodyAddr.x && addr.field === bodyAddr.field;
  switch (arg?.$type) {
    case "FieldAddr":
      return sameField(arg);
    case "UnOp":
      return sameField(arg.x);
    case "ChangeInterface":
      return arg.x?.$type === "UnOp" && sameField(arg.x.x);
  }
  return false;
}

// typeString formats a type as Go does. A call without results has a nil
// tuple type, which Go formats as "()".
function typeString(t: types.Type | null): string {
  return t?.string() ?? "()";
}

function isClosureCalled(closure: ssa.MakeClosure): boolean {
  return closure.referrers().some((ref) => ref?.$type === "Call" || ref?.$type === "Defer");
}

function isNamedType(t: types.Type | null, path: string, name: string): boolean {
  const object = t?.$type === "Named" ? t.obj() : null;
  return object?.name() === name && object.pkg()?.path() === path;
}

// removeVendor strips a vendor directory prefix from an import path.
function removeVendor(path: string): string {
  const i = path.indexOf("vendor/");
  return i >= 0 ? path.slice(i + "vendor/".length) : path;
}
