import { isPkgDotName } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "waitgroup-by-value";

export function create(): Rule {
  return { name, apply };
}

// Revive walks the file but stops at function declarations, which are only
// top-level, so checking the declarations is equivalent.
function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  for (const decl of file.ast.decls) {
    if (decl?.$type !== "FuncDecl") {
      continue;
    }
    for (const field of decl.type!.params!.list) {
      if (isPkgDotName(field!.type, "sync", "WaitGroup")) {
        failures.push({ failure: "sync.WaitGroup passed by value, the function will get a copy of the original one", node: field!, confidence: 1 });
      }
    }
  }
  return failures;
}
