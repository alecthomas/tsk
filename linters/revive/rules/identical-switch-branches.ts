import type * as ast from "go/ast";
import * as token from "go/token";
import { goFmt, type Visitor, walk } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "identical-switch-branches";

export interface Options {
  /** Allow the default clause to be identical to a case clause. */
  allowIdenticalDefault: boolean;
}

export const defaults: Options = { allowIdenticalDefault: false };

export function create(options: DeepReadonly<Options>): Rule {
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      const walkBody = (body: readonly (ast.Stmt | null)[]): void => {
        for (const stmt of body) {
          walk(visitor, stmt!);
        }
      };
      const visitor: Visitor = {
        visit(node) {
          // Untagged switches are skipped, as the order of their cases may matter.
          if (node?.$type !== "SwitchStmt" || (node as ast.SwitchStmt).tag === null) {
            return visitor;
          }
          // Branch hashes to the lines of their case clauses.
          const hashes = new Map<string, number>();
          for (const stmt of (node as ast.SwitchStmt).body!.list) {
            const caseClause = stmt as ast.CaseClause;
            if (doesFallthrough(caseClause.body)) {
              continue;
            }
            // An identical default spells out which values are handled
            // explicitly, so it is neither reported nor recorded.
            if (options.allowIdenticalDefault && caseClause.list.length === 0) {
              walkBody(caseClause.body);
              continue;
            }
            // Revive hashes a block of the clause's statements.
            const hash = caseClause.body.map((s) => goFmt(s!)).join("\n");
            const branchLine = file.toPosition(caseClause.pos()).line;
            const matchLine = hashes.get(hash);
            if (matchLine !== undefined) {
              failures.push({ failure: `"switch" with identical branches (lines ${matchLine} and ${branchLine})`, node, confidence: 1 });
            }
            hashes.set(hash, branchLine);
            walkBody(caseClause.body);
          }
          return null;
        },
      };
      for (const decl of file.ast.decls) {
        if (decl!.$type === "FuncDecl" && (decl as ast.FuncDecl).body !== null) {
          walk(visitor, (decl as ast.FuncDecl).body!);
        }
      }
      return failures;
    },
  };
}

function doesFallthrough(stmts: readonly (ast.Stmt | null)[]): boolean {
  const last = stmts[stmts.length - 1];
  return last?.$type === "BranchStmt" && (last as ast.BranchStmt).tok === token.FALLTHROUGH;
}
