import type * as ast from "go/ast";
import { type Visitor, walk } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "bare-return";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  // Finds bare returns in one body, leaving function literals to the outer walk.
  const finder: Visitor = {
    visit(node) {
      if (node === null || node.$type === "FuncLit") {
        return null;
      }
      if (node.$type === "ReturnStmt" && (node as ast.ReturnStmt).results.length === 0) {
        failures.push({ failure: "avoid using bare returns, please add return expressions", confidence: 1, node });
      }
      return finder;
    },
  };
  const checkFunc = (results: ast.FieldList | null, body: ast.BlockStmt | null) => {
    const named = results !== null && results.list.length > 0 && results.list[0]!.names.length > 0;
    if (named && body !== null) {
      walk(finder, body);
    }
  };
  walk(
    {
      visit(node) {
        if (node !== null && (node.$type === "FuncDecl" || node.$type === "FuncLit")) {
          const fn = node as ast.FuncDecl | ast.FuncLit;
          checkFunc(fn.type!.results, fn.body);
        }
        return this;
      },
    },
    file.ast,
  );
  return failures;
}
