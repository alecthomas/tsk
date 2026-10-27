// Port of golang.org/x/tools/go/analysis/passes/httpmux at v0.50.0.
import * as ast from "go/ast";
import * as constant from "go/constant";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { imports, isFunctionNamed, isTypeNamed, receiverNamed } from "./internal/typesinternal";

export default defineAnalyzer({
  name: "httpmux",
  doc: `report using Go 1.22 enhanced ServeMux patterns in older Go versions

The httpmux analysis is active for Go modules configured to run with Go 1.21 or
earlier versions. It reports calls to net/http.ServeMux.Handle and HandleFunc
methods whose patterns use features added in Go 1.22, like HTTP methods (such as
"GET") and wildcards. (See https://pkg.go.dev/net/http#ServeMux for details.)
Such patterns can be registered in older versions of Go, but will not behave as expected.`,
  group: "govet",
  enabledByDefault: false,
  requires: [inspect],
  run(pass) {
    if (goVersionAfter121(pass.pkg.goVersion()) || !imports(pass.pkg, "net/http")) {
      return;
    }
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      if (isServeMuxRegisterCall(pass, call)) {
        const arg = call.args[0]!;
        const pat = stringConstantExpr(pass, arg);
        if (pat !== null && likelyEnhancedPattern(pat)) {
          pass.report({
            pos: arg.pos(),
            end: arg.end(),
            message: "possible enhanced ServeMux pattern used with Go version before 1.22 (update go.mod file?)",
          });
        }
      }
    }
  },
});

// Reports whether call statically calls http.Handle, http.HandleFunc, or the
// (*http.ServeMux) methods of the same names.
function isServeMuxRegisterCall(pass: Pass<unknown>, call: ast.CallExpr): boolean {
  const fn = typeutil.staticCallee(pass.typesInfo, call);
  if (fn === null) {
    return false;
  }
  if (isFunctionNamed(fn, "net/http", "Handle", "HandleFunc")) {
    return true;
  }
  // Unlike typesinternal.isMethodNamed, this ignores the receiver type name.
  const recv = fn.signature()!.recv();
  if (fn.pkg()?.path() !== "net/http" || recv === null || !["Handle", "HandleFunc"].includes(fn.name())) {
    return false;
  }
  const { isPtr, named } = receiverNamed(recv);
  return isPtr && isTypeNamed(named, "net/http", "ServeMux");
}

function stringConstantExpr(pass: Pass<unknown>, expr: ast.Expr): string | null {
  const lit = pass.typesInfo.types.get(expr)?.value ?? null;
  return lit !== null && lit.kind() === constant.String ? constant.stringVal(lit) : null;
}

// A valid wildcard must start a segment, and its name must be a valid Go identifier.
const wildcardRegexp = /\/\{[_\p{L}][_\p{L}\p{Nd}]*(\.\.\.)?\}/u;

// Reports whether the pattern probably contains an HTTP method name or a
// wildcard; a space suggests that it begins with a method.
function likelyEnhancedPattern(pat: string): boolean {
  return pat.includes(" ") || wildcardRegexp.test(pat);
}

// Reports whether goVersion is after go1.21, comparing as semver after the
// conversion pkgsite's stdlib.VersionForTag makes. An empty version may be the stdlib.
function goVersionAfter121(goVersion: string): boolean {
  if (goVersion === "") {
    return true;
  }
  // go1, go1.0, and malformed versions are not after go1.21.
  const m = /^go(\d+)\.(\d+)(?:\.(\d+))?((beta|rc)(\d+))?$/.exec(goVersion);
  if (m === null) {
    return false;
  }
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3] ?? "0")];
  if (major !== 1) {
    return major > 1;
  }
  // A prerelease of go1.21.0 is before it.
  return minor > 21 || (minor === 21 && patch > 0);
}
