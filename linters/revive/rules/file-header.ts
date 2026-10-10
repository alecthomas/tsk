import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "file-header";

export interface Options {
  /** A regular expression the file's first comment must match; empty disables the rule. */
  header: string;
}

export const defaults: Options = { header: "" };

export function create(options: DeepReadonly<Options>): Rule {
  if (options.header === "") {
    return { name, apply: () => [] };
  }
  // The header is a JavaScript regular expression, where revive's is Go's.
  // Revive compiles it per file and reports a bad one as a lint failure.
  let header: RegExp;
  try {
    header = new RegExp(options.header);
  } catch (e) {
    throw new Error(`invalid value in the "header" option of the "file-header" rule: ${e}`);
  }
  return {
    name,
    apply(file: File): Failure[] {
      const failure = [{ failure: "the file doesn't have an appropriate header", node: file.ast, confidence: 1 }];
      if (file.ast.comments.length === 0) {
        return failure;
      }
      const comment = file.ast.comments[0]!.list
        .map((c) => {
          const text = c!.text;
          if (text.startsWith("/*")) {
            return text.slice(2, -2);
          }
          return text.startsWith("//") ? text.slice(2) : text;
        })
        .join("");
      return header.test(comment) ? [] : failure;
    },
  };
}
