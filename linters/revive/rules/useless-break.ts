import type * as ast from "go/ast";
import * as token from "go/token";
import { type Visitor, walk } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "useless-break";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  // Like upstream, leaving any loop clears this, even inside an outer loop.
  let inLoopBody = false;
  const inspectCase = (body: readonly (ast.Stmt | null)[]) => {
    if (body.length === 0) {
      return;
    }
    const s = body[body.length - 1]!;
    if (s.$type !== "BranchStmt" || (s as ast.BranchStmt).tok !== token.BREAK || (s as ast.BranchStmt).label !== null) {
      return;
    }
    let failure = "useless break in case clause";
    if (inLoopBody) {
      failure += " (WARN: this break statement affects this switch or select statement and not the loop enclosing it)";
    }
    failures.push({ failure, confidence: 1, node: s });
  };
  const visitor: Visitor = {
    visit(node) {
      if (node === null) {
        return null;
      }
      switch (node.$type) {
        case "ForStmt":
        case "RangeStmt":
          inLoopBody = true;
          walk(visitor, (node as ast.ForStmt | ast.RangeStmt).body!);
          inLoopBody = false;
          return null;
        case "CommClause":
          inspectCase((node as ast.CommClause).body);
          return null;
        case "CaseClause":
          inspectCase((node as ast.CaseClause).body);
          return null;
      }
      return visitor;
    },
  };
  walk(visitor, file.ast);
  return failures;
}
