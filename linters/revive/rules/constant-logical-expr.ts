import * as ast from "go/ast";
import * as token from "go/token";
import { goFmt } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "constant-logical-expr";

const logicalOperators = new Set([token.LAND, token.LOR, token.EQL, token.LSS, token.GTR, token.NEQ, token.LEQ, token.GEQ]);
const equalityOperators = new Set([token.EQL, token.LEQ, token.GEQ]);
const inequalityOperators = new Set([token.LSS, token.GTR, token.NEQ]);

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
    if (!logicalOperators.has(n.op) || goFmt(n.x!) !== goFmt(n.y!)) {
      return true;
    }
    let failure = "left and right hand-side sub-expressions are the same";
    if (equalityOperators.has(n.op)) {
      failure = "expression always evaluates to true";
    } else if (inequalityOperators.has(n.op)) {
      failure = "expression always evaluates to false";
    }
    failures.push({ failure, node: n, confidence: 1 });
    return true;
  });
  return failures;
}
