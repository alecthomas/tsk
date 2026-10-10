import type * as ast from "go/ast";
import * as token from "go/token";
import { type Visitor, walk } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "useless-fallthrough";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  const commentMap = file.commentMap();
  const visitor: Visitor = {
    visit(node) {
      if (node === null || node.$type !== "SwitchStmt") {
        return visitor;
      }
      const switchStmt = node as ast.SwitchStmt;
      if (switchStmt.tag === null) {
        return visitor;
      }
      const clauses = switchStmt.body!.list as ast.CaseClause[];
      // As upstream, only clauses with a reported fallthrough are walked further.
      for (let i = 0; i < clauses.length - 1; i++) {
        const body = clauses[i].body;
        if (body.length !== 1 || body[0]!.$type !== "BranchStmt") {
          continue;
        }
        const branch = body[0] as ast.BranchStmt;
        // Falling through to default is a valid pattern.
        if (branch.tok !== token.FALLTHROUGH || clauses[i + 1].list.length === 0) {
          continue;
        }
        failures.push({
          failure: `this "fallthrough" can be removed by consolidating this case clause with the next one`,
          // A comment may explain the fallthrough.
          confidence: commentMap.has(branch) ? 0.5 : 1,
          node: branch,
        });
        walk(visitor, clauses[i]);
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
}
