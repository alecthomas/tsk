import type * as ast from "go/ast";
import * as token from "go/token";
import { isPkgDotName } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "error-naming";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  for (const decl of file.ast.decls) {
    if (decl!.$type !== "GenDecl" || (decl as ast.GenDecl).tok !== token.VAR) {
      continue;
    }
    for (const s of (decl as ast.GenDecl).specs) {
      const spec = s as ast.ValueSpec;
      if (spec.names.length !== 1 || spec.values.length !== 1 || spec.values[0]!.$type !== "CallExpr") {
        continue;
      }
      const ce = spec.values[0] as ast.CallExpr;
      if (!isPkgDotName(ce.fun, "errors", "New") && !isPkgDotName(ce.fun, "fmt", "Errorf")) {
        continue;
      }
      const id = spec.names[0]!;
      // Unused blank error variables are common in benchmarks and examples.
      if (id.name === "_") {
        continue;
      }
      const prefix = id.isExported() ? "Err" : "err";
      if (!id.name.startsWith(prefix)) {
        failures.push({ failure: `error var ${id.name} should have name of the form ${prefix}Foo`, confidence: 0.9, node: id });
      }
    }
  }
  return failures;
}
