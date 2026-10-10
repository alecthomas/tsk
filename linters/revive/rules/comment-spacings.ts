import { isDirectiveComment } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "comment-spacings";

export interface Options {
  /** Comment prefixes, without the leading "//", that need no space after "//". */
  allowList: string[];
}

export const defaults: Options = { allowList: [] };

const defaultAllowList = ["//#nosec"];

export function create(options: DeepReadonly<Options>): Rule {
  const allowList = [...defaultAllowList, ...options.allowList.map((allow) => `//${allow}`)];
  const isAllowed = (line: string): boolean => allowList.some((allow) => line.startsWith(allow)) || isDirectiveComment(line);
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      for (const group of file.ast.comments) {
        for (const comment of group!.list) {
          const line = comment!.text;
          if (line.length < 3) {
            continue;
          }
          if (line[1] === "*" && line[2] === "\n") {
            continue;
          }
          if (line[2] === " " || line[2] === "\t" || isAllowed(line)) {
            continue;
          }
          failures.push({ failure: "no space between comment delimiter and comment text", node: comment!, confidence: 1 });
        }
      }
      return failures;
    },
  };
}
