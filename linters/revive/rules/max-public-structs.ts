import * as ast from "go/ast";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "max-public-structs";

export interface Options {
  /** The most public types a file may declare, or less than 1 for no limit. */
  max: number;
}

export const defaults: Options = { max: 5 };

export function create(options: DeepReadonly<Options>): Rule {
  return {
    name,
    apply(file: File): Failure[] {
      if (options.max < 1) {
        return [];
      }
      // Revive counts every type declaration, not only structs, whose name's
      // first character equals its upper case, which includes "_".
      let count = 0;
      ast.inspect(file.ast, (n) => {
        if (n?.$type === "TypeSpec") {
          // Revive upper-cases the name's first byte and this its first
          // UTF-16 unit, which differs only for non-ASCII names.
          const first = (n as ast.TypeSpec).name!.name.charAt(0);
          if (first.toUpperCase() === first) {
            count++;
          }
        }
        return true;
      });
      if (count <= options.max) {
        return [];
      }
      return [{ failure: `you have exceeded the maximum number (${options.max}) of public struct declarations`, node: file.ast, confidence: 1 }];
    },
  };
}
