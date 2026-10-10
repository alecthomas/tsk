import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "line-length-limit";

export interface Options {
  /** The longest line allowed, in characters, with tabs as four. */
  max: number;
  /** Regular expressions matching lines that may be longer. */
  excludes: string[];
}

export const defaults: Options = { max: 80, excludes: [] };

export function create(options: DeepReadonly<Options>): Rule {
  if (options.max < 0) {
    throw new Error(`invalid value passed as argument number to the "line-length-limit" rule`);
  }
  // Patterns are JavaScript regular expressions, where revive's are Go's.
  const excludes = options.excludes.map((pattern) => {
    if (pattern === "") {
      throw new Error(`invalid value in the "excludes" option of the "line-length-limit" rule: regular expression must not be empty`);
    }
    try {
      return new RegExp(pattern);
    } catch (e) {
      throw new Error(`invalid value in the "excludes" option of the "line-length-limit" rule: regexp "${pattern}" does not compile: ${e}`);
    }
  });
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      const tokenFile = file.tokenFile();
      // bufio.Scanner splits lines at "\n", dropping a trailing "\r".
      const lines = file.content().split("\n");
      if (lines[lines.length - 1] === "") {
        lines.pop();
      }
      lines.forEach((raw, i) => {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (excludes.some((exclude) => exclude.test(line))) {
          return;
        }
        const length = [...line.split("\t").join("    ")].length;
        if (length > options.max) {
          const pos = tokenFile.lineStart(i + 1);
          failures.push({ failure: `line is ${length} characters, out of limit ${options.max}`, pos, end: pos, confidence: 1 });
        }
      });
      return failures;
    },
  };
}
