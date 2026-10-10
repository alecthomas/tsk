import type * as ast from "go/ast";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "file-length-limit";

export interface Options {
  /** The most lines a file may have; 0 disables the rule. */
  max: number;
  /** Do not count comment lines. */
  skipComments: boolean;
  /** Do not count blank lines. */
  skipBlankLines: boolean;
}

export const defaults: Options = { max: 0, skipComments: false, skipBlankLines: false };

export function create(options: DeepReadonly<Options>): Rule {
  if (options.max < 0 || !Number.isInteger(options.max)) {
    const type = Number.isInteger(options.max) ? "int64" : "float64";
    throw new Error(`invalid configuration value for max lines in "file-length-limit" rule; need positive int64 but got ${type}`);
  }
  if (options.max === 0) {
    return { name, apply: () => [] };
  }
  return {
    name,
    apply(file: File): Failure[] {
      // bufio.Scanner splits lines at "\n", without a final empty line.
      const lines = file.content().split("\n");
      if (lines[lines.length - 1] === "") {
        lines.pop();
      }
      const all = lines.length;
      let count = all;
      if (options.skipComments) {
        count -= countCommentLines(file.ast.comments);
      }
      if (options.skipBlankLines) {
        count -= lines.filter((line) => line.trim() === "").length;
      }
      if (count <= options.max) {
        return [];
      }
      const pos = file.tokenFile().lineStart(all);
      return [{ failure: `file length is ${count} lines, which exceeds the limit of ${options.max}`, pos, end: pos, confidence: 1 }];
    },
  };
}

function countCommentLines(comments: readonly (ast.CommentGroup | null)[]): number {
  let count = 0;
  for (const group of comments) {
    for (const comment of group!.list) {
      const text = comment!.text;
      if (text[1] === "/") {
        count++;
      } else if (text[1] === "*") {
        count += text.split("\n").length;
      }
    }
  }
  return count;
}
