import type * as ast from "go/ast";
import { parseExpr } from "go/parser";
import * as token from "go/token";
import { goFmt, walk } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "unnecessary-if";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  const visitor = {
    visit(node: ast.Node | null) {
      if (node === null || node.$type !== "IfStmt") {
        return visitor;
      }
      const failure = check(node as ast.IfStmt);
      if (failure === undefined) {
        return visitor;
      }
      failures.push(failure);
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

// Matches if cond { return <bool> } else { return <bool> } and
// if cond { x = <bool> } else { x = <bool> }.
function check(ifStmt: ast.IfStmt): Failure | undefined {
  // Only a single if...else without an initializer.
  if (ifStmt.else === null || ifStmt.init !== null || ifStmt.else.$type !== "BlockStmt") {
    return undefined;
  }
  const thenStmts = ifStmt.body!.list;
  const elseStmts = (ifStmt.else as ast.BlockStmt).list;
  if (thenStmts.length !== 1 || elseStmts.length !== 1) {
    return undefined;
  }
  const thenStmt = thenStmts[0]!;
  let found: { replacement: string; thenBool: boolean } | undefined;
  switch (thenStmt.$type) {
    case "ReturnStmt":
      found = replacementForReturn(thenStmt as ast.ReturnStmt, elseStmts[0]!);
      break;
    case "AssignStmt":
      found = replacementForAssignment(thenStmt as ast.AssignStmt, elseStmts[0]!);
      break;
  }
  if (found === undefined) {
    return undefined;
  }
  const cond = condAsString(ifStmt.cond!, !found.thenBool);
  return { failure: `replace this conditional by: ${found.replacement} ${cond}`, confidence: 1, node: ifStmt };
}

const relationalOppositeOf = new Map<token.Token, token.Token>([
  [token.EQL, token.NEQ],
  [token.GEQ, token.LSS],
  [token.GTR, token.LEQ],
  [token.LEQ, token.GTR],
  [token.LSS, token.GEQ],
  [token.NEQ, token.EQL],
]);

// Prints cond, negated with as few negations as it can.
function condAsString(cond: ast.Expr, mustNegate: boolean): string {
  const result = goFmt(cond);
  if (!mustNegate) {
    return result;
  }
  if (cond.$type === "BinaryExpr") {
    const bin = cond as ast.BinaryExpr;
    const opposite = relationalOppositeOf.get(bin.op);
    if (opposite !== undefined) {
      // Upstream prints the node with its operator swapped. AST nodes are
      // read-only here, so this reparses the swapped expression and prints
      // that; the operators share a precedence, so the tree is the same.
      const swapped = parseExpr(`${goFmt(bin.x!)} ${token.Token.string(opposite)} ${goFmt(bin.y!)}`);
      if (swapped !== null) {
        return goFmt(swapped);
      }
    }
  }
  return `!(${result})`;
}

function replacementForAssignment(thenStmt: ast.AssignStmt, elseStmt: ast.Stmt): { replacement: string; thenBool: boolean } | undefined {
  const thenBool = singleBooleanLiteral(thenStmt.rhs);
  if (thenBool === undefined) {
    return undefined;
  }
  const thenLHS = goFmt(thenStmt.lhs[0]!);
  if (elseStmt.$type !== "AssignStmt") {
    return undefined;
  }
  const els = elseStmt as ast.AssignStmt;
  if (goFmt(els.lhs[0]!) !== thenLHS || singleBooleanLiteral(els.rhs) === undefined) {
    return undefined;
  }
  return { replacement: `${thenLHS} ${token.Token.string(thenStmt.tok)}`, thenBool: thenBool === "true" };
}

function replacementForReturn(thenStmt: ast.ReturnStmt, elseStmt: ast.Stmt): { replacement: string; thenBool: boolean } | undefined {
  const thenBool = singleBooleanLiteral(thenStmt.results);
  if (thenBool === undefined || elseStmt.$type !== "ReturnStmt") {
    return undefined;
  }
  if (singleBooleanLiteral((elseStmt as ast.ReturnStmt).results) === undefined) {
    return undefined;
  }
  return { replacement: "return", thenBool: thenBool === "true" };
}

// The literal of a single true or false identifier, or undefined.
function singleBooleanLiteral(exprs: readonly (ast.Expr | null)[]): string | undefined {
  if (exprs.length !== 1 || exprs[0]!.$type !== "Ident") {
    return undefined;
  }
  const name = (exprs[0] as ast.Ident).name;
  return name === "true" || name === "false" ? name : undefined;
}
