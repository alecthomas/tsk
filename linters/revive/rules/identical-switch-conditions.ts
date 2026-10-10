import type * as ast from "go/ast";
import { goFmt, type Visitor, walk } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "identical-switch-conditions";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  const visitor: Visitor = {
    visit(node) {
      // Only untagged switches, whose cases are conditions.
      if (node?.$type !== "SwitchStmt" || (node as ast.SwitchStmt).tag !== null) {
        return visitor;
      }
      // Condition hashes to the lines of their case clauses.
      const hashes = new Map<string, number>();
      for (const stmt of (node as ast.SwitchStmt).body!.list) {
        const caseClause = stmt as ast.CaseClause;
        const caseLine = file.toPosition(caseClause.pos()).line;
        for (const expr of caseClause.list) {
          const hash = goFmt(expr!);
          const matchLine = hashes.get(hash);
          if (matchLine !== undefined) {
            failures.push({ failure: `case clause at line ${matchLine} has the same condition`, node: caseClause, confidence: 1 });
          }
          hashes.set(hash, caseLine);
        }
        walk(visitor, caseClause);
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
