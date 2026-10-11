import { defineAnalyzer } from "tsk";
import { runRule } from "../lint";
import type * as ast from "go/ast";
import { goFmt, isPkgDotName } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "context-as-argument";

export interface Options {
  /** Parameter types, as written in source, that may come before a context.Context. */
  allowTypesBefore: string[];
}

export const defaults: Options = { allowTypesBefore: [] };

export function create(options: DeepReadonly<Options>): Rule {
  // A context.Context may always follow another context.Context.
  const allowTypes = new Set([...options.allowTypesBefore, "context.Context"]);
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      for (const decl of file.ast.decls) {
        if (decl!.$type !== "FuncDecl") {
          continue;
        }
        const params = (decl as ast.FuncDecl).type!.params!.list;
        if (params.length <= 1) {
          continue;
        }
        let ctxAllowed = true;
        for (const param of params) {
          if (isPkgDotName(param!.type, "context", "Context") && !ctxAllowed) {
            failures.push({ node: param!, confidence: 0.9, failure: "context.Context should be the first parameter of a function" });
            break;
          }
          ctxAllowed = allowTypes.has(goFmt(param!.type!));
        }
      }
      return failures;
    },
  };
}

export default defineAnalyzer<Options>({
  name: "context_as_argument",
  doc: "`context.Context` should be the first argument of a function.",
  url: "https://github.com/mgechev/revive/blob/v1.17.0/RULES_DESCRIPTIONS.md#context-as-argument",
  group: "revive",
  runDespiteErrors: true,
  config: defaults,
  run(pass) {
    runRule(pass, create(pass.config));
  },
});
