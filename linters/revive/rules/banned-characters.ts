import * as ast from "go/ast";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "banned-characters";

export interface Options {
  /** Characters, or substrings, that identifiers must not contain. */
  characters: string[];
}

export const defaults: Options = { characters: [] };

export function create(options: DeepReadonly<Options>): Rule {
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      ast.inspect(file.ast, (n) => {
        if (n !== null && n.$type === "Ident") {
          const id = n as ast.Ident;
          for (const c of options.characters) {
            if (id.name.includes(c)) {
              failures.push({ failure: `banned character found: ${c}`, node: id, confidence: 1 });
            }
          }
        }
        return true;
      });
      return failures;
    },
  };
}
