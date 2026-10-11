// Port of golang.org/x/tools/go/analysis/passes/defers at v0.50.0.
import * as ast from "go/ast";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";
import { imports, isFunctionNamed } from "./internal/typesinternal";

export default defineAnalyzer({
  name: "defers",
  doc: `report common mistakes in defer statements

The defers analyzer reports a diagnostic when a defer statement would
result in a non-deferred call to time.Since, as experience has shown
that this is nearly always a mistake.

For example:

	start := time.Now()
	...
	defer recordLatency(time.Since(start)) // error: call to time.Since is not deferred

The correct code is:

	defer func() { recordLatency(time.Since(start)) }()`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/defers",
  group: "govet",
  requires: [inspect],
  run(pass) {
    if (!imports(pass.pkg, "time")) {
      return;
    }
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.DeferStmt)) {
      const d = cursor.node() as ast.DeferStmt;
      ast.inspect(d.call, (node) => {
        if (node?.$type === "CallExpr") {
          if (isFunctionNamed(typeutil.callee(pass.typesInfo, node), "time", "Since")) {
            pass.report({ pos: node.pos(), message: "call to time.Since is not deferred" });
          }
        } else if (node?.$type === "FuncLit") {
          return false;
        }
        return true;
      });
    }
  },
});
