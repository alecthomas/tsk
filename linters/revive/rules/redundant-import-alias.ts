import type * as ast from "go/ast";
import type { Failure, File, Rule } from "../lint";

export const name = "redundant-import-alias";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  for (const imp of file.ast.imports) {
    if (imp!.name !== null && importPackageName(imp!) === imp!.name.name) {
      failures.push({ failure: `Import alias ${JSON.stringify(imp!.name.name)} is redundant`, confidence: 1, node: imp! });
    }
  }
  return failures;
}

// importPackageName is the last element of the import path, which is not
// always the package's name.
function importPackageName(imp: ast.ImportSpec): string {
  const path = imp.path!.value;
  return path
    .slice(path.lastIndexOf("/") + 1)
    .replace(/^"+|"+$/g, "");
}
