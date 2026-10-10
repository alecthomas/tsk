import { isPkgDotName, walk, type Visitor } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "call-to-gc";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  const visitor: Visitor = {
    visit(node) {
      if (node === null || node.$type !== "CallExpr") {
        return visitor;
      }
      if (!isPkgDotName(node.fun, "runtime", "GC")) {
        return null;
      }
      failures.push({ failure: "explicit call to the garbage collector", node, confidence: 1 });
      return visitor;
    },
  };
  walk(visitor, file.ast);
  return failures;
}
