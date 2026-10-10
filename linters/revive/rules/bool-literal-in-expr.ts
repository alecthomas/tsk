import * as ast from "go/ast";
import * as token from "go/token";
import type { Failure, File, Rule } from "../lint";

export const name = "bool-literal-in-expr";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  ast.inspect(file.ast, (node) => {
    if (node?.$type !== "BinaryExpr") {
      return true;
    }
    const n = node as ast.BinaryExpr;
    if (!isBoolOp(n.op)) {
      return true;
    }
    const lexeme = booleanLit(n.x) ?? booleanLit(n.y);
    if (lexeme === undefined) {
      return true;
    }
    const isConstant = (n.op === token.LAND && lexeme === "false") || (n.op === token.LOR && lexeme === "true");
    const failure = isConstant ? `Boolean expression seems to always evaluate to ${lexeme}` : "omit Boolean literal in expression";
    failures.push({ failure, node: n, confidence: 1 });
    return true;
  });
  return failures;
}

function isBoolOp(t: token.Token): boolean {
  return t === token.LAND || t === token.LOR || t === token.EQL || t === token.NEQ;
}

function booleanLit(n: ast.Expr | null): string | undefined {
  if (n?.$type !== "Ident") {
    return undefined;
  }
  const name = (n as ast.Ident).name;
  return name === "true" || name === "false" ? name : undefined;
}
