import * as types from "go/types";
import type * as ssa from "golang.org/x/tools/go/ssa";
import { defineAnalyzer, type Pass } from "tsk";
import { buildssa } from "tsk/passes";

const sqlPackages = ["database/sql", "github.com/jmoiron/sqlx", "github.com/jackc/pgx/v5", "github.com/jackc/pgx/v5/pgxpool"];

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

type Action = "unhandled" | "handled" | "returned" | "passed" | "closed" | "other";

export default defineAnalyzer({
  name: "sqlclosecheck",
  doc: "Checks that sql.Rows, sql.Stmt, sqlx.NamedStmt, pgx.Query are closed.",
  requires: [buildssa],
  run(pass) {
    const result = pass.resultOf(buildssa);
    const targets = targetTypes(result.pkg?.prog ?? null);
    if (targets.length === 0) {
      return;
    }
    new Checker(pass, targets).run(result.srcFuncs as ssa.Function[]);
  },
});

// targetTypes returns *Rows, Rows, *Stmt, and *NamedStmt from each SQL package
// the program imports.
function targetTypes(prog: ssa.Program | null): types.Type[] {
  const targets: types.Type[] = [];
  for (const path of sqlPackages) {
    const pkg = prog?.importedPackage(path);
    if (pkg === null || pkg === undefined) {
      continue;
    }
    const named = (name: string) => {
      const t = pkg.type(name)?.object()?.type();
      return t?.$type === "Named" ? t : null;
    };
    const rows = named("Rows");
    const stmt = named("Stmt");
    const namedStmt = named("NamedStmt");
    if (rows !== null) {
      targets.push(types.newPointer(rows)!, rows);
    }
    for (const t of [stmt, namedStmt]) {
      if (t !== null) {
        targets.push(types.newPointer(t)!);
      }
    }
  }
  return targets;
}

class Checker {
  constructor(
    private readonly pass: Pass<unknown>,
    private readonly targets: types.Type[],
  ) {}

  run(funcs: ssa.Function[]): void {
    for (const fn of funcs) {
      for (const block of fn.blocks) {
        for (const instr of block!.instrs) {
          if (instr?.$type !== "Call") {
            continue;
          }
          for (const value of this.targetValues(instr)) {
            const refs = (value.referrers() ?? []) as ssa.Instruction[];
            if (!this.checkClosed(refs)) {
              this.pass.report({ pos: instr.pos(), message: "Rows/Stmt/NamedStmt was not closed" });
            }
            this.checkDeferred(refs, false);
          }
        }
      }
    }
  }

  private isTarget(t: types.Type | null): boolean {
    return this.targets.some((target) => types.identical(t, target));
  }

  // targetValues returns the values that hold rows or statements a call
  // returns: its referrers of a target type, or their first argument.
  private targetValues(call: ssa.Call): ssa.Value[] {
    const values: ssa.Value[] = [];
    const results = call.call.signature()!.results();
    for (let i = 0; i < (results?.len() ?? 0); i++) {
      const resultType = results!.at(i)!.type();
      for (const target of this.targets) {
        if (!types.identical(resultType, target)) {
          continue;
        }
        for (const ref of call.referrers() ?? []) {
          if (ref?.$type === "Call") {
            const arg = ref.call.args[0];
            if (arg && types.identical(arg.type(), target)) {
              values.push(arg);
            }
          } else if (ref !== null && valueInstrs.has(ref.$type)) {
            const value = ref as ssa.Value;
            if (types.identical(value.type(), target)) {
              values.push(value);
            }
          }
        }
      }
    }
    return values;
  }

  private checkClosed(refs: ssa.Instruction[]): boolean {
    return refs.some((ref, i) => {
      const action = this.action(ref);
      // A value passed on as the last use is the receiver's to close.
      return action === "closed" || action === "returned" || action === "handled" || (action === "passed" && i === refs.length - 1);
    });
  }

  private closedInFunction(fn: ssa.Value | null): boolean {
    return fn?.$type === "Function" && fn.blocks.some((b) => this.checkClosed(b!.instrs as ssa.Instruction[]));
  }

  private action(instr: ssa.Instruction): Action {
    switch (instr.$type) {
      case "Defer": {
        const call = instr.call;
        if (call.value?.name() === "Close" || call.method?.name() === "Close") {
          return "closed";
        }
        // A deferred function may close it.
        if (call.method === null && this.closedInFunction(call.value)) {
          return "handled";
        }
        return "other";
      }
      case "Call": {
        if (instr.call.value === null) {
          return "other";
        }
        const recv = instr.call.staticCallee()?.signature?.recv() ?? null;
        const isTarget = recv !== null && this.isTarget(recv.type());
        if (!isTarget) {
          return "passed";
        }
        return instr.call.value.name() === "Close" ? "closed" : "unhandled";
      }
      case "Phi":
      case "MakeInterface":
        return "passed";
      case "Store": {
        // Stored in a struct, it may be closed by a different flow.
        if (instr.addr?.$type === "FieldAddr") {
          return "returned";
        }
        const refs = instr.addr?.referrers() ?? [];
        if (refs.length === 0) {
          return "other";
        }
        return refs.some((ref) => ref?.$type === "MakeClosure" && this.closedInFunction(ref.fn)) ? "handled" : "unhandled";
      }
      case "UnOp":
        return this.isTarget(instr.type()) && this.checkClosed((instr.referrers() ?? []) as ssa.Instruction[]) ? "handled" : "unhandled";
      case "FieldAddr":
        return this.checkClosed((instr.referrers() ?? []) as ssa.Instruction[]) ? "handled" : "unhandled";
      case "Return":
        return instr.results.some((result) => this.isTarget(result!.type())) ? "returned" : "unhandled";
      default:
        return "unhandled";
    }
  }

  // checkDeferred reports Close called without defer, outside deferred closures.
  private checkDeferred(instrs: ssa.Instruction[], inDefer: boolean): void {
    for (const instr of instrs) {
      switch (instr.$type) {
        case "Defer":
          if (instr.call.value?.name() === "Close" || instr.call.method?.name() === "Close") {
            return;
          }
          break;
        case "Call":
          if (instr.call.value?.name() === "Close") {
            if (!inDefer) {
              this.pass.report({ pos: instr.pos(), message: "Close should use defer" });
            }
            return;
          }
          break;
        case "Store": {
          const refs = instr.addr?.referrers() ?? [];
          if (refs.length === 0) {
            return;
          }
          for (const ref of refs) {
            if (ref?.$type === "MakeClosure" && ref.fn?.$type === "Function") {
              for (const block of ref.fn.blocks) {
                this.checkDeferred(block!.instrs as ssa.Instruction[], true);
              }
            }
          }
          break;
        }
        case "UnOp":
          if (this.isTarget(instr.type())) {
            this.checkDeferred((instr.referrers() ?? []) as ssa.Instruction[], inDefer);
          }
          break;
        case "FieldAddr":
          this.checkDeferred((instr.referrers() ?? []) as ssa.Instruction[], inDefer);
          break;
      }
    }
  }
}
