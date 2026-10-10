import * as ast from "go/ast";
import type { Failure, File, Rule } from "../lint";

export const name = "use-any";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  // The alias any was added in Go 1.18.
  if (!file.pkg.isAtLeastGoVersion("1.18")) {
    return [];
  }
  const failures: Failure[] = [];
  ast.inspect(file.ast, (n) => {
    if (n !== null && n.$type === "InterfaceType" && (n as ast.InterfaceType).methods!.list.length === 0) {
      failures.push({ node: n, confidence: 1, failure: "since Go 1.18 'interface{}' can be replaced by 'any'" });
    }
    return true;
  });
  return failures;
}
