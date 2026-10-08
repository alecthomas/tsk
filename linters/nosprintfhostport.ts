import * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";

// Formats such as "scheme://%s:port", without and with a user before the host.
const withoutUser = /^[a-zA-Z][a-zA-Z0-9+-.]*:\/\/%s:[^@]*$/;
const withUser = /^[a-zA-Z][a-zA-Z0-9+-.]*:\/\/[^/]*@%s:.*$/;

export default defineAnalyzer({
  name: "nosprintfhostport",
  doc: "Checks for misuse of Sprintf to construct a host with port in a URL.",
  url: "https://github.com/stbenjam/no-sprintf-host-port",
  requires: [inspect],
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      const fun = call.fun;
      // Matched by name, as upstream does, without resolving the package.
      if (fun?.$type !== "SelectorExpr" || fun.x?.$type !== "Ident" || fun.x.name !== "fmt" || fun.sel!.name !== "Sprintf") {
        continue;
      }
      if (buildsHostPort(call.args as ast.Expr[])) {
        pass.report({ pos: call.pos(), message: "host:port in url should be constructed with net.JoinHostPort and not directly with fmt.Sprintf" });
      }
    }
  },
});

function buildsHostPort(args: ast.Expr[]): boolean {
  const format = literal(args[0]);
  if (format === null) {
    return false;
  }
  if (withoutUser.test(format)) {
    // A literal host without a colon, as in Sprintf("http://%s:8080", "host"), is fine.
    const host = args.length <= 3 ? literal(args[1]) : null;
    if (host === null || host.includes(":")) {
      return true;
    }
  }
  return withUser.test(format);
}

// literal returns the source text between a string literal's quotes, without
// unescaping it.
function literal(expr: ast.Expr | undefined): string | null {
  if (expr?.$type !== "BasicLit" || expr.kind !== token.STRING || expr.value.length < 2) {
    return null;
  }
  return expr.value.slice(1, -1);
}
