import { defineAnalyzer } from "tsk";
import { runRule } from "../lint";
import type * as ast from "go/ast";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "argument-limit";

export interface Options {
  /** The most parameters a function may have. */
  max: number;
}

export const defaults: Options = { max: 8 };

export function create(options: DeepReadonly<Options>): Rule {
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      for (const decl of file.ast.decls) {
        if (decl!.$type !== "FuncDecl") {
          continue;
        }
        const type = (decl as ast.FuncDecl).type!;
        // Unnamed parameters do not count, as in revive.
        const count = type.params!.list.reduce((n, field) => n + field!.names.length, 0);
        if (count > options.max) {
          failures.push({ failure: `maximum number of arguments per function exceeded; max ${options.max} but got ${count}`, node: type, confidence: 1 });
        }
      }
      return failures;
    },
  };
}

export default defineAnalyzer<Options>({
  name: "argument_limit",
  doc: "Specifies the maximum number of arguments a function can receive",
  group: "revive",
  enabledByDefault: false,
  runDespiteErrors: true,
  config: defaults,
  run(pass) {
    runRule(pass, create(pass.config));
  },
});
