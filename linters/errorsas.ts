// Port of golang.org/x/tools/go/analysis/passes/errorsas at v0.50.0.
import * as ast from "go/ast";
import * as types from "go/types";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";
import { isFunctionNamed } from "./internal/typesinternal";

const notPointerToError = "second argument to errors.As must be a non-nil pointer to either a type that implements error, or to any interface type";

export default defineAnalyzer({
  name: "errorsas",
  doc: `report passing non-pointer or non-error values to errors.As

The errorsas analyzer reports calls to errors.As where the type
of the second argument is not a pointer to a type implementing error.
For example:

	var unwrappedErr net.DNSError
	errors.As(err, unwrappedErr) // should use &unwrappedErr, DNSError.Error has a pointer receiver`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/errorsas",
  // Upstream finds calls with the typeindex pass, which tsk does not provide.
  requires: [inspect],
  run(pass) {
    const path = pass.pkg.path();
    if (path === "errors" || path === "errors_test") {
      // These packages know how to use their own APIs.
      return;
    }
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      // Skip a spread call errors.As(pair()).
      if (!isFunctionNamed(typeutil.callee(pass.typesInfo, call), "errors", "As") || call.args.length < 2) {
        continue;
      }
      const err = checkAsTarget(pass.typesInfo, call.args[1]!);
      if (err !== null) {
        pass.report({ pos: call.pos(), end: call.end(), message: err });
      }
    }
  },
});

// checkAsTarget returns why the second argument to errors.As is invalid, or
// null if it is valid.
function checkAsTarget(info: types.Info, e: ast.Expr): string | null {
  const anyType = types.Universe!.lookup("any")!.type();
  const errorType = types.Universe!.lookup("error")!.type();
  const u = info.types.get(e)?.type?.underlying() ?? null;
  if (types.identical(u, anyType)) {
    // A target of any often forwards a value from another source.
    return null;
  }
  if (u?.$type !== "Pointer") {
    return notPointerToError;
  }
  const elem = u.elem();
  if (types.identical(elem, errorType)) {
    return "second argument to errors.As should not be *error";
  }
  if (!types.isInterface(elem) && !types.assignableTo(elem, errorType)) {
    return notPointerToError;
  }
  return null;
}
