import * as ast from "go/ast";
import * as token from "go/token";
import type { Failure, File, Rule } from "../lint";

export const name = "increment-decrement";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  ast.inspect(file.ast, (n) => {
    if (n === null || n.$type !== "AssignStmt") {
      return true;
    }
    const as = n as ast.AssignStmt;
    if (as.lhs.length !== 1 || !isOne(as.rhs[0]!)) {
      return true;
    }
    const suffix = as.tok === token.ADD_ASSIGN ? "++" : as.tok === token.SUB_ASSIGN ? "--" : null;
    if (suffix !== null) {
      failures.push({ node: as, confidence: 0.8, failure: `should replace ${file.render(as)} with ${file.render(as.lhs[0]!)}${suffix}` });
    }
    return true;
  });
  return failures;
}

function isOne(expr: ast.Expr): boolean {
  return expr.$type === "BasicLit" && (expr as ast.BasicLit).kind === token.INT && (expr as ast.BasicLit).value === "1";
}
