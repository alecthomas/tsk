// Port of golang.org/x/tools/go/analysis/passes/deepequalerrors at v0.50.0.
import * as ast from "go/ast";
import * as types from "go/types";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { imports, isFunctionNamed } from "./internal/typesinternal";

export default defineAnalyzer({
  name: "deepequalerrors",
  doc: `check for calls of reflect.DeepEqual on error values

The deepequalerrors checker looks for calls of the form:

    reflect.DeepEqual(err1, err2)

where err1 and err2 are errors. Using reflect.DeepEqual to compare
errors is discouraged.`,
  group: "govet",
  enabledByDefault: false,
  requires: [inspect],
  run(pass) {
    if (!imports(pass.pkg, "reflect")) {
      return;
    }
    const errorType = types.Universe!.lookup("error")!.type()!.underlying()!;
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      const obj = typeutil.callee(pass.typesInfo, call);
      // Unlike upstream, which panics, skip a spread call DeepEqual(pair()).
      if (
        isFunctionNamed(obj, "reflect", "DeepEqual") &&
        call.args.length === 2 &&
        hasError(pass, errorType, call.args[0]!) &&
        hasError(pass, errorType, call.args[1]!)
      ) {
        pass.report({ pos: call.pos(), end: call.end(), message: "avoid using reflect.DeepEqual with errors" });
      }
    }
  },
});

// hasError reports whether the type of e contains the type error.
function hasError(pass: Pass<unknown>, errorType: types.Type, e: ast.Expr): boolean {
  const tv = pass.typesInfo.types.get(e);
  if (tv === undefined) {
    return false;
  }
  return containsError(errorType, tv.type);
}

// containsError reports whether any comparable type that typ could store, such
// as itself, its fields, elements, keys and pointees, is error.
function containsError(errorType: types.Type, typ: types.Type | null): boolean {
  // Wrappers keep Go pointer identity, so this tracks identical type pointers.
  const inProgress = new Set<types.Type>();
  const check = (t: types.Type | null): boolean => {
    if (t === null) {
      return false;
    }
    if (t === errorType) {
      return true;
    }
    if (inProgress.has(t)) {
      return false;
    }
    inProgress.add(t);
    switch (t.$type) {
      case "Pointer":
      case "Slice":
      case "Array":
        return check(t.elem());
      case "Map":
        return check(t.key()) || check(t.elem());
      case "Struct":
        for (const field of t.fields()) {
          if (check(field!.type())) {
            return true;
          }
        }
        return false;
      case "Named":
      case "Alias":
        return check(t.underlying());
      default:
        return false;
    }
  };
  return check(typ);
}
