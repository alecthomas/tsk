import * as ast from "go/ast";
import * as token from "go/token";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "enforce-switch-style";

export interface Options {
  /** Allow switches without a default clause. */
  allowNoDefault: boolean;
  /** Allow a default clause that is not the last clause. */
  allowDefaultNotLast: boolean;
}

export const defaults: Options = { allowNoDefault: false, allowDefaultNotLast: false };

export function create(options: DeepReadonly<Options>): Rule {
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      ast.inspect(file.ast, (node) => {
        if (node?.$type !== "SwitchStmt" && node?.$type !== "TypeSwitchStmt") {
          return true;
        }
        const body = (node as ast.SwitchStmt | ast.TypeSwitchStmt).body!;
        const clauses = body.list as ast.CaseClause[];
        let defaultIndex = -1;
        clauses.forEach((c, i) => {
          if (c.list.length === 0) {
            defaultIndex = i;
          }
        });
        if (defaultIndex < 0) {
          if (!options.allowNoDefault && !allBranchesEndWithJumpStmt(clauses)) {
            failures.push({ failure: "switch must have a default case clause", node, confidence: 1 });
          }
          return true;
        }
        if (!options.allowDefaultNotLast && defaultIndex !== clauses.length - 1) {
          failures.push({ failure: "default case clause must be the last one", node: clauses[defaultIndex], confidence: 1 });
        }
        return true;
      });
      return failures;
    },
  };
}

function allBranchesEndWithJumpStmt(clauses: ast.CaseClause[]): boolean {
  return clauses.every((clause) => {
    const last = clause.body[clause.body.length - 1];
    if (last === undefined) {
      return false;
    }
    return last!.$type === "ReturnStmt" || (last!.$type === "BranchStmt" && (last as ast.BranchStmt).tok === token.BREAK);
  });
}
