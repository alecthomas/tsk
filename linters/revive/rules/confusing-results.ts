import type * as ast from "go/ast";
import { goFmt } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "confusing-results";

const message = "unnamed results of the same type may be confusing, consider using named results";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  for (const decl of file.ast.decls) {
    if (decl!.$type !== "FuncDecl") {
      continue;
    }
    const results = (decl as ast.FuncDecl).type!.results;
    if (results === null || results.list.length <= 1 || results.list[0]!.names.length > 0) {
      continue;
    }
    // Only adjacent results of the same type are confusing.
    let lastType = "";
    for (const result of results.list) {
      const typeName = goFmt(result!.type!);
      if (typeName === lastType) {
        failures.push({ failure: message, node: result!, confidence: 1 });
        break;
      }
      lastType = typeName;
    }
  }
  return failures;
}
