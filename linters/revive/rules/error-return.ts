import type * as ast from "go/ast";
import { isIdent } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "error-return";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  for (const decl of file.ast.decls) {
    if (decl!.$type !== "FuncDecl") {
      continue;
    }
    const fn = decl as ast.FuncDecl;
    const results = fn.type!.results?.list ?? [];
    if (results.length <= 1 || isIdent(results[results.length - 1]!.type, "error")) {
      continue;
    }
    if (results.slice(0, -1).some((r) => isIdent(r!.type, "error"))) {
      failures.push({ node: fn, confidence: 0.9, failure: "error should be the last type when returning multiple items" });
    }
  }
  return failures;
}
