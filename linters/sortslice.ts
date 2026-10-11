// Port of golang.org/x/tools/go/analysis/passes/sortslice at v0.50.0.
import * as ast from "go/ast";
import type * as types from "go/types";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer, formatNode, type Pass, type SuggestedFix } from "tsk";
import { inspect } from "tsk/passes";
import { imports, isFunctionNamed } from "./internal/typesinternal";

export default defineAnalyzer({
  name: "sortslice",
  doc: `check the argument type of sort.Slice

sort.Slice requires an argument of a slice type. Check that
the interface{} value passed to sort.Slice is actually a slice.`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/sortslice",
  group: "govet",
  enabledByDefault: false,
  requires: [inspect],
  run(pass) {
    if (!imports(pass.pkg, "sort")) {
      return;
    }
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      const callee = typeutil.callee(pass.typesInfo, call);
      if (!isFunctionNamed(callee, "sort", "Slice", "SliceStable", "SliceIsSorted")) {
        continue;
      }
      const arg = call.args[0]!;
      const typ = pass.typesInfo.types.get(arg)!.type!;
      // Slice(f(...)) passes the first result of f.
      const first = typ.$type === "Tuple" ? typ.at(0)!.type()! : typ;
      const u = first.underlying();
      if (u?.$type === "Slice" || u?.$type === "Interface") {
        continue;
      }
      pass.report({
        pos: call.pos(),
        end: call.end(),
        message: `${(callee as types.Func).fullName()}'s argument must be a slice; is called with ${typ.string()}`,
        suggestedFixes: fixes(pass, arg, typ),
      });
    }
  },
});

// The fixes wrap the argument's formatted text where upstream prints a
// synthetic AST around it; the output is the same.
function fixes(pass: Pass<unknown>, arg: ast.Expr, typ: types.Type): SuggestedFix[] {
  const fix = (message: string, newText: string): SuggestedFix[] => [{ message, textEdits: [{ pos: arg.pos(), end: arg.end(), newText }] }];
  const v = typ.underlying();
  switch (v?.$type) {
    case "Array":
      return fix("Get a slice of the full array", `${formatNode(arg, pass.fset)}[:]`);
    case "Pointer":
      if (v.elem()!.underlying()?.$type !== "Slice") {
        return [];
      }
      return fix("Dereference the pointer to the slice", `*${formatNode(arg, pass.fset)}`);
    case "Signature":
      if (v.params()!.len() !== 0 || v.results()!.len() !== 1) {
        return [];
      }
      if (v.results()!.at(0)!.type()!.underlying()?.$type !== "Slice") {
        return [];
      }
      return fix("Call the function", `${formatNode(arg, pass.fset)}()`);
    default:
      return [];
  }
}
