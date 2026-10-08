import * as ast from "go/ast";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";

export default defineAnalyzer({
  name: "goprintffuncname",
  doc: `check that printf-like functions are named with f at the end

A function without results whose last parameters are format string and
args ...any formats like fmt.Printf, so its name should end in f, which also
lets go vet check its calls.`,
  url: "https://github.com/golangci/go-printf-func-name",
  requires: [inspect],
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.FuncDecl)) {
      const fn = cursor.node() as ast.FuncDecl;
      const type = fn.type!;
      if ((type.results?.list.length ?? 0) !== 0) {
        continue;
      }
      const params = type.params!.list;
      if (params.length < 2) {
        continue;
      }
      const format = params[params.length - 2]!;
      const names = format.names;
      if (format.type?.$type !== "Ident" || format.type.name !== "string" || names.length === 0 || names[names.length - 1]!.name !== "format") {
        continue;
      }
      const args = params[params.length - 1]!.type;
      if (args?.$type !== "Ellipsis" || !isAny(args) || fn.name!.name.endsWith("f")) {
        continue;
      }
      const name = fn.name!.name;
      pass.report({ pos: fn.pos(), message: `printf-like formatting function '${name}' should be named '${name}f'` });
    }
  },
});

function isAny(ellipsis: ast.Ellipsis): boolean {
  const elt = ellipsis.elt;
  if (elt?.$type === "InterfaceType") {
    return (elt.methods?.list.length ?? 0) === 0;
  }
  return elt?.$type === "Ident" && elt.name === "any";
}
