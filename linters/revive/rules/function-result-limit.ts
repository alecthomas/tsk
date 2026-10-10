import type * as ast from "go/ast";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "function-result-limit";

export interface Options {
  /** The most results a function may return. */
  max: number;
}

export const defaults: Options = { max: 3 };

export function create(options: DeepReadonly<Options>): Rule {
  if (options.max < 0) {
    throw new Error(`the value passed as return results number to the "function-result-limit" rule cannot be negative`);
  }
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      for (const decl of file.ast.decls) {
        if (decl!.$type !== "FuncDecl") {
          continue;
        }
        const type = (decl as ast.FuncDecl).type!;
        const count = type.results === null ? 0 : type.results.numFields();
        if (count > options.max) {
          failures.push({ failure: `maximum number of return results per function exceeded; max ${options.max} but got ${count}`, node: type, confidence: 1 });
        }
      }
      return failures;
    },
  };
}
