// Port of golang.org/x/tools/go/analysis/passes/appends at v0.50.0.
import * as ast from "go/ast";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";

export default defineAnalyzer({
  name: "appends",
  doc: `check for missing values after append

This checker reports calls to append that pass
no values to be appended to the slice.

	s := []string{"a", "b", "c"}
	_ = append(s)

Such calls are always no-ops and often indicate an
underlying mistake.`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/appends",
  requires: [inspect],
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      const b = typeutil.callee(pass.typesInfo, call);
      if (b?.$type === "Builtin" && b.name() === "append" && call.args.length === 1) {
        pass.report({ pos: call.pos(), end: call.end(), message: "append with no values" });
      }
    }
  },
});
