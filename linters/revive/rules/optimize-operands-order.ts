import * as ast from "go/ast";
import * as token from "go/token";
import { goFmt, seekNode } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "optimize-operands-order";

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
    if (n.op !== token.LAND && n.op !== token.LOR) {
      return true;
    }
    // The left operand must call a function and the right must not.
    if (seekNode(n.x, isCaller) === null || seekNode(n.y, isCaller) !== null) {
      return true;
    }
    const expr = goFmt(n);
    failures.push({
      failure: `for better performance '${expr}' might be rewritten as '${swapped(n, expr)}'`,
      node: n,
      confidence: 0.3,
    });
    return true;
  });
  return failures;
}

function isCaller(n: ast.Node): boolean {
  if (n.$type !== "CallExpr") {
    return false;
  }
  const fun = (n as ast.CallExpr).fun!;
  if (fun.$type !== "Ident") {
    return true;
  }
  return (fun as ast.Ident).name !== "len" || (fun as ast.Ident).obj !== null;
}

// swapped prints n with its operands swapped. Revive prints a new node; this
// splits n's text, which prints each operand as it would print in the swap.
function swapped(n: ast.BinaryExpr, expr: string): string {
  const op = n.op === token.LAND ? " && " : " || ";
  const left = goFmt(n.x!).replace(/\s/g, "");
  for (let i = expr.indexOf(op); i >= 0; i = expr.indexOf(op, i + 1)) {
    if (expr.slice(0, i).replace(/\s/g, "") === left) {
      return `${expr.slice(i + op.length)}${op}${expr.slice(0, i)}`;
    }
  }
  return `${goFmt(n.y!)}${op}${goFmt(n.x!)}`;
}
