// Port of golang.org/x/tools/go/analysis/passes/atomic at v0.50.0.
import * as ast from "go/ast";
import * as token from "go/token";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer, formatNode, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { imports, isFunctionNamed } from "./internal/typesinternal";

export default defineAnalyzer({
  name: "atomic",
  doc: `check for common mistakes using the sync/atomic package

The atomic checker looks for assignment statements of the form:

	x = atomic.AddUint64(&x, 1)

which are not atomic.`,
  group: "govet",
  requires: [inspect],
  runDespiteErrors: true,
  run(pass) {
    if (!imports(pass.pkg, "sync/atomic")) {
      return;
    }
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.AssignStmt)) {
      const n = cursor.node() as ast.AssignStmt;
      if (n.lhs.length !== n.rhs.length || (n.lhs.length === 1 && n.tok === token.DEFINE)) {
        continue;
      }
      n.rhs.forEach((right, i) => {
        if (right?.$type !== "CallExpr") {
          return;
        }
        const obj = typeutil.callee(pass.typesInfo, right);
        if (isFunctionNamed(obj, "sync/atomic", "AddInt32", "AddInt64", "AddUint32", "AddUint64", "AddUintptr")) {
          checkAtomicAddAssignment(pass, n.lhs[i]!, right);
        }
      });
    }
  },
});

// checkAtomicAddAssignment reports assigning the result of an atomic.Add* call
// to the variable it operates on.
function checkAtomicAddAssignment(pass: Pass<unknown>, left: ast.Expr, call: ast.CallExpr): void {
  if (call.args.length !== 2) {
    return;
  }
  const arg = call.args[0]!;
  let broken = false;
  if (arg.$type === "UnaryExpr" && arg.op === token.AND) {
    broken = formatNode(left, pass.fset) === formatNode(arg.x!, pass.fset);
  } else if (left.$type === "StarExpr") {
    broken = formatNode(left.x!, pass.fset) === formatNode(arg, pass.fset);
  }
  if (broken) {
    pass.report({ pos: left.pos(), end: left.end(), message: "direct assignment to atomic value" });
  }
}
