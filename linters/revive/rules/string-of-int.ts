import * as ast from "go/ast";
import * as types from "go/types";
import type { Failure, File, Rule } from "../lint";

export const name = "string-of-int";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  ast.inspect(file.ast, (n) => {
    if (n !== null && n.$type === "CallExpr") {
      const call = n as ast.CallExpr;
      if (isStringCast(file, call.fun!) && isIntExpression(file, call.args)) {
        failures.push({ node: call, confidence: 1, failure: "dubious conversion of an integer into a string, use strconv.Itoa" });
      }
    }
    return true;
  });
  return failures;
}

function underlyingBasic(file: File, e: ast.Expr): types.Basic | null {
  const u = file.pkg.typeOf(e)?.underlying() ?? null;
  return u !== null && u.$type === "Basic" ? u : null;
}

function isStringCast(file: File, e: ast.Expr): boolean {
  return underlyingBasic(file, e)?.kind() === types.String;
}

function isIntExpression(file: File, es: readonly (ast.Expr | null)[]): boolean {
  if (es.length !== 1) {
    return false;
  }
  const ut = underlyingBasic(file, es[0]!);
  if (ut === null || (ut.info() & types.IsInteger) === 0) {
    return false;
  }
  const kind = ut.kind();
  return kind !== types.Byte && kind !== types.Rune && kind !== types.UntypedRune;
}
