import type * as ast from "go/ast";
import * as token from "go/token";
import { isIdent, walk } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "if-return";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  walk(
    {
      visit(node) {
        if (node !== null && node.$type === "BlockStmt") {
          checkBlock(file.ast, node as ast.BlockStmt, failures);
        }
        return this;
      },
    },
    file.ast,
  );
  return failures;
}

function checkBlock(astFile: ast.File, block: ast.BlockStmt, failures: Failure[]): void {
  const list = block.list;
  for (let i = 0; i < list.length - 1; i++) {
    // if var := whatever; var != nil { return var }
    if (list[i]!.$type !== "IfStmt") {
      continue;
    }
    const s = list[i] as ast.IfStmt;
    if (s.body === null || s.body.list.length !== 1 || s.else !== null) {
      continue;
    }
    if (s.init === null || s.init.$type !== "AssignStmt") {
      continue;
    }
    const assign = s.init as ast.AssignStmt;
    if (assign.lhs.length !== 1 || (assign.tok !== token.DEFINE && assign.tok !== token.ASSIGN)) {
      continue;
    }
    const id = assign.lhs[0]!;
    if (id.$type !== "Ident") {
      continue;
    }
    const idName = (id as ast.Ident).name;
    const cond = s.cond!;
    if (cond.$type !== "BinaryExpr") {
      continue;
    }
    const expr = cond as ast.BinaryExpr;
    if (expr.op !== token.NEQ || !isIdent(expr.x, idName) || !isIdent(expr.y, "nil")) {
      continue;
    }
    if (!isSingleIdentReturn(s.body.list[0], idName)) {
      continue;
    }
    // return nil
    const next = list[i + 1]!;
    if (!isSingleIdentReturn(next, "nil")) {
      continue;
    }
    // Comments explaining the construct justify it.
    if (containsComments(s.pos(), next.pos(), astFile)) {
      continue;
    }
    failures.push({ failure: "redundant if ...; err != nil check, just return error instead.", confidence: 0.9, node: s });
  }
}

function isSingleIdentReturn(stmt: ast.Stmt | null, ident: string): boolean {
  if (stmt === null || stmt.$type !== "ReturnStmt") {
    return false;
  }
  const results = (stmt as ast.ReturnStmt).results;
  return results.length === 1 && isIdent(results[0], ident);
}

function containsComments(start: token.Pos, end: token.Pos, f: ast.File): boolean {
  for (const group of f.comments) {
    const comments = group!.list;
    if (comments[0]!.slash >= end) {
      return false;
    }
    if (comments[comments.length - 1]!.slash < start) {
      continue;
    }
    // Upstream exempts its own test expectations.
    if (comments.some((c) => start <= c!.slash && c!.slash < end && !c!.text.startsWith("// MATCH "))) {
      return true;
    }
  }
  return false;
}
