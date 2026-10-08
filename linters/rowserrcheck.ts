import * as types from "go/types";
import type * as ssa from "golang.org/x/tools/go/ssa";
import { defineAnalyzer, type Pass } from "tsk";
import { buildssa } from "tsk/passes";

interface Config {
  /** Packages with a Rows type to check besides database/sql, such as github.com/jmoiron/sqlx. */
  packages: string[];
}

// valueInstrs names the SSA instructions that are also values.
const valueInstrs = new Set([
  "Alloc",
  "BinOp",
  "Call",
  "ChangeInterface",
  "ChangeType",
  "Convert",
  "Extract",
  "Field",
  "FieldAddr",
  "Index",
  "IndexAddr",
  "Lookup",
  "MakeChan",
  "MakeClosure",
  "MakeInterface",
  "MakeMap",
  "MakeSlice",
  "MultiConvert",
  "Next",
  "Phi",
  "Range",
  "Select",
  "Slice",
  "SliceToArrayPointer",
  "TypeAssert",
  "UnOp",
]);

export default defineAnalyzer<Config>({
  name: "rowserrcheck",
  doc: "checks whether Rows.Err of rows is checked successfully",
  url: "https://github.com/jingyugao/rowserrcheck",
  requires: [buildssa],
  config: { packages: [] },
  run(pass) {
    const result = pass.resultOf(buildssa);
    for (const path of [...pass.config.packages, "database/sql"]) {
      const rows = result.pkg?.prog?.importedPackage(path)?.type("Rows")?.object();
      const named = rows?.type();
      if (named?.$type !== "Named") {
        continue;
      }
      const iface = named.underlying();
      new Checker(pass, types.newPointer(named)!, iface?.$type === "Interface" ? iface : null).run(result.srcFuncs as ssa.Function[]);
    }
  },
});

// Checker finds calls returning a package's *Rows whose Err method is never
// called.
class Checker {
  constructor(
    private readonly pass: Pass<Config>,
    private readonly rowsType: types.Type,
    private readonly rowsInterface: types.Interface | null,
  ) {}

  run(funcs: ssa.Function[]): void {
    for (const fn of funcs) {
      // Functions returning rows leave checking them to their callers.
      if (resultTypes(fn.signature!).some((t) => types.identical(t, this.rowsType))) {
        continue;
      }
      for (const block of fn.blocks) {
        block!.instrs.forEach((instr, i) => {
          if (this.errCallMissing(block!, i)) {
            this.pass.report({ pos: instr!.pos(), message: "rows.Err must be checked" });
          }
        });
      }
    }
  }

  private isRows(t: types.Type | null): boolean {
    return types.identical(t, this.rowsType) || (this.rowsInterface !== null && types.implements_(t, this.rowsInterface));
  }

  // errCallMissing reports whether instruction i of a block is a call
  // returning rows on which Err is never called.
  private errCallMissing(block: ssa.BasicBlock, i: number): boolean {
    const call = block.instrs[i];
    if (call?.$type !== "Call") {
      return false;
    }
    if (!resultTypes(call.call.signature()!).some((t) => this.isRows(t))) {
      return false;
    }
    const callRefs = call.referrers();
    if (callRefs === null) {
      return false;
    }
    for (const ref of callRefs) {
      const value = this.rowsValue(ref!);
      if (value === null) {
        continue;
      }
      const valueRefs = value.referrers();
      if (valueRefs === null) {
        return false;
      }
      if (valueRefs.some((r) => this.errCalled(r!))) {
        return false;
      }
    }
    return true;
  }

  // rowsValue returns the rows a call's referrer holds or passes on.
  private rowsValue(instr: ssa.Instruction): ssa.Value | null {
    if (instr.$type === "Call") {
      const args = instr.call.args;
      return args.length === 1 && this.isRows(args[0]!.type()) ? args[0] : null;
    }
    if (valueInstrs.has(instr.$type)) {
      const value = instr as ssa.Value;
      return this.isRows(value.type()) ? value : null;
    }
    return null;
  }

  // errCalled reports whether a use of rows leads to a call of Err.
  private errCalled(ref: ssa.Instruction): boolean {
    switch (ref.$type) {
      case "Phi":
        return (ref.referrers() ?? []).some((r) => this.errCalled(r!));
      case "Store":
        // Rows captured by a closure.
        for (const aref of ref.addr!.referrers() ?? []) {
          if (aref?.$type === "MakeClosure") {
            if (this.calledInFunc(aref.fn as ssa.Function, this.isClosureCalled(aref))) {
              return true;
            }
          } else if (aref?.$type === "UnOp" && (aref.referrers() ?? []).some((r) => this.errCalled(r!))) {
            return true;
          }
        }
        return false;
      case "Call": {
        if (isErrCall(ref)) {
          return true;
        }
        // Upstream treats any instruction in a called function that is not
        // itself an unchecked rows call as checking the rows.
        const fn = ref.call.value;
        return fn?.$type === "Function" && fn.blocks.some((b) => b!.instrs.some((_, i) => !this.errCallMissing(b!, i)));
      }
      case "FieldAddr":
        return (ref.referrers() ?? []).some((r) => r?.$type === "UnOp" && (r.referrers() ?? []).some((u) => isErrCall(u!)));
      default:
        return false;
    }
  }

  private isClosureCalled(closure: ssa.MakeClosure): boolean {
    return (closure.referrers() ?? []).some((ref) => ref?.$type === "Call" || ref?.$type === "Defer");
  }

  private calledInFunc(fn: ssa.Function, called: boolean): boolean {
    for (const block of fn.blocks) {
      for (let i = 0; i < block!.instrs.length; i++) {
        const instr = block!.instrs[i]!;
        if (instr.$type === "UnOp") {
          const callsErr = (instr.referrers() ?? []).some((ref) => ref?.$type === "Call" && ref.call.value?.name() === "Err");
          if (callsErr && called) {
            return true;
          }
        } else if (this.errCallMissing(block!, i) || !called) {
          return false;
        }
      }
    }
    return false;
  }
}

// resultTypes lists a signature's result types. Without results, the tuple
// is nil.
function resultTypes(sig: types.Signature): (types.Type | null)[] {
  const results = sig.results();
  return [...Array(results?.len() ?? 0).keys()].map((i) => results!.at(i)!.type());
}

function isErrCall(instr: ssa.Instruction): boolean {
  if (instr.$type !== "Call" && instr.$type !== "Defer") {
    return false;
  }
  return instr.call.value?.name() === "Err" || instr.call.method?.name() === "Err";
}
