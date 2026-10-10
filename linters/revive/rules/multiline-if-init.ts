import type * as ast from "go/ast";
import { walk } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "multiline-if-init";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  walk(
    {
      visit(node) {
        if (node !== null && node.$type === "IfStmt") {
          const init = (node as ast.IfStmt).init;
          if (init !== null && file.toPosition(init.end()).line > file.toPosition(init.pos()).line) {
            failures.push({ failure: "if-init statement should not span multiple lines", confidence: 1, node });
          }
        }
        return this;
      },
    },
    file.ast,
  );
  return failures;
}
