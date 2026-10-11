// Port of golang.org/x/tools/go/analysis/passes/reflectvaluecompare at v0.50.0.
import * as ast from "go/ast";
import * as token from "go/token";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { isFunctionNamed, isTypeNamed } from "./internal/typesinternal";

export default defineAnalyzer({
  name: "reflectvaluecompare",
  doc: `check for comparing reflect.Value values with == or reflect.DeepEqual

The reflectvaluecompare checker looks for expressions of the form:

	v1 == v2
	v1 != v2
	reflect.DeepEqual(v1, v2)

where v1 or v2 are reflect.Values. Comparing reflect.Values directly
is almost certainly not correct, as it compares the reflect package's
internal representation, not the underlying value.
Likely what is intended is:

	v1.Interface() == v2.Interface()
	v1.Interface() != v2.Interface()
	reflect.DeepEqual(v1.Interface(), v2.Interface())`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/reflectvaluecompare",
  group: "govet",
  enabledByDefault: false,
  requires: [inspect],
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.BinaryExpr, ast.CallExpr)) {
      const n = cursor.node()!;
      if (n.$type === "BinaryExpr") {
        if (n.op !== token.EQL && n.op !== token.NEQ) {
          continue;
        }
        if (isReflectValue(pass, n.x!) || isReflectValue(pass, n.y!)) {
          pass.report({ pos: n.pos(), end: n.end(), message: `avoid using ${n.op === token.EQL ? "==" : "!="} with reflect.Value` });
        }
      } else if (n.$type === "CallExpr") {
        const obj = typeutil.callee(pass.typesInfo, n);
        if (isFunctionNamed(obj, "reflect", "DeepEqual") && (isReflectValue(pass, n.args[0]!) || isReflectValue(pass, n.args[1]!))) {
          pass.report({ pos: n.pos(), end: n.end(), message: "avoid using reflect.DeepEqual with reflect.Value" });
        }
      }
    }
  },
});

function isReflectValue(pass: Pass<unknown>, e: ast.Expr): boolean {
  const tv = pass.typesInfo.types.get(e);
  if (tv === undefined || !isTypeNamed(tv.type, "reflect", "Value")) {
    return false;
  }
  // reflect.Value{} is a valid, if unidiomatic, way to test validity.
  return e.$type !== "CompositeLit";
}
