import type * as ast from "go/ast";
import { goFmt, walk, type Visitor } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "use-fmt-print";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const redefined = new Set<string>();
  for (const decl of file.ast.decls) {
    if (decl!.$type === "FuncDecl" && (decl as ast.FuncDecl).recv === null) {
      redefined.add((decl as ast.FuncDecl).name!.name);
    }
  }
  const failures: Failure[] = [];
  // Like revive, it does not look inside calls other than to print and println.
  const visitor: Visitor = {
    visit(node) {
      if (node === null || node.$type !== "CallExpr") {
        return visitor;
      }
      const call = node as ast.CallExpr;
      if (call.fun!.$type !== "Ident") {
        return null;
      }
      const fn = (call.fun as ast.Ident).name;
      if ((fn !== "print" && fn !== "println") || redefined.has(fn)) {
        return null;
      }
      const args = call.args.map((arg) => goFmt(arg!)).join(", ");
      failures.push({
        node,
        confidence: 1,
        failure: `avoid using built-in function "${fn}", replace it by "fmt.F${fn}(os.Stderr, ${args})"`,
      });
      return visitor;
    },
  };
  walk(visitor, file.ast);
  return failures;
}
