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
