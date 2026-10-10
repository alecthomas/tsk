import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "imports-blocklist";

export interface Options {
  /** Import paths that must not be imported, as regular expressions where ** matches any path. */
  packages: string[];
}

export const defaults: Options = { packages: [] };

export function create(options: DeepReadonly<Options>): Rule {
  // Patterns are JavaScript regular expressions, where revive's are Go's.
  const blocklist = options.packages.map((arg) => {
    try {
      return new RegExp(`"${arg.replace(/\/?\*\*\/?/g, "(\\W|\\w)*")}"$`, "m");
    } catch (e) {
      throw new Error(`invalid argument to the imports-blocklist rule. Expecting "${arg}" to be a valid regular expression, got: ${e}`);
    }
  });
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      for (const imp of file.ast.imports) {
        const path = imp!.path;
        if (path !== null && blocklist.some((re) => re.test(path.value))) {
          failures.push({ node: imp!, confidence: 1, failure: `should not use the following blocklisted import: ${path.value}` });
        }
      }
      return failures;
    },
  };
}
