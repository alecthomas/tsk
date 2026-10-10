import { quote } from "../../internal/strconv";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "dot-imports";

export interface Options {
  /** Import paths that may be dot imported. */
  allowedPackages: string[];
}

export const defaults: Options = { allowedPackages: [] };

export function create(options: DeepReadonly<Options>): Rule {
  // Import path literals are double quoted.
  const allowed = new Set(options.allowedPackages.map(quote));
  return {
    name,
    apply(file: File): Failure[] {
      return file.ast.imports
        .filter((imp) => imp!.name !== null && imp!.name.name === "." && !allowed.has(imp!.path!.value))
        .map((imp) => ({ node: imp!, confidence: 1, failure: "should not use dot imports" }));
    },
  };
}
