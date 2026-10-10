import * as filepath from "path/filepath";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "filename-format";

export interface Options {
  /** A regular expression file names must match. */
  format: string;
}

export const defaults: Options = { format: "^[_A-Za-z0-9][_A-Za-z0-9-]*\\.go$" };

export function create(options: DeepReadonly<Options>): Rule {
  // The format is a JavaScript regular expression, where revive's is Go's.
  let format: RegExp;
  try {
    format = new RegExp(options.format);
  } catch (e) {
    throw new Error(`rule "filename-format" expects a valid regexp argument, got error for ${options.format}: ${e}`);
  }
  return {
    name,
    apply(file: File): Failure[] {
      const filename = filepath.base(file.name);
      if (format.test(filename)) {
        return [];
      }
      return [
        { failure: `Filename ${filename} is not of the format ${options.format}.${nonASCIIMessage(filename)}`, confidence: 1, node: file.ast.name! },
      ];
    },
  };
}

function nonASCIIMessage(s: string): string {
  let result = "";
  for (const c of s) {
    const code = c.codePointAt(0)!;
    if (code > 0x7f) {
      result += ` Non ASCII character ${c} (U+${code.toString(16).toUpperCase().padStart(4, "0")}) found.`;
    }
  }
  return result;
}
