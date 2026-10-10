import type * as ast from "go/ast";
import * as token from "go/token";
import { isIdent, isStringLiteral, pickNodes, walk, type Visitor } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "use-slices-concat";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  if (!file.pkg.isAtLeastGoVersion("1.22")) {
    return [];
  }
  const failures: Failure[] = [];
  const addFailure = (node: ast.Node, failure: string) => {
    failures.push({ failure, node, confidence: 0.8 });
  };
  // checkConsecutiveAppends spots s := append([]T{}, s1...) followed by s = append(s, s2...).
  const checkConsecutiveAppends = (stmts: readonly (ast.Stmt | null)[]) => {
    for (let i = 0; i + 1 < stmts.length; i++) {
      const target = appendToEmptySliceTarget(stmts[i]!);
      if (target !== undefined && appendsToTarget(stmts[i + 1]!, target)) {
        addFailure(stmts[i]!, "replace consecutive appends by a call to slices.Concat");
      }
    }
  };
  const visitor: Visitor = {
    visit(n) {
      if (n === null) {
        return visitor;
      }
      switch (n.$type) {
        case "BlockStmt":
          checkConsecutiveAppends(n.list);
          break;
        case "CaseClause":
        case "CommClause":
          checkConsecutiveAppends(n.body);
          break;
        case "CallExpr": {
          const appended = appendedSlices(n);
          if (appended.length > 1 && appended.slice(1).every(isSideEffectFree)) {
            addFailure(n, "replace nested appends by a call to slices.Concat");
            // Walk only the appended slices, not to report the nested appends again.
            for (const slice of appended) {
              walk(visitor, slice);
            }
            return null;
          }
          break;
        }
      }
      return visitor;
    },
  };
  walk(visitor, file.ast);
  return failures;
}

// appendToEmptySliceTarget returns the variable s := append([]T{}, s1...) defines.
function appendToEmptySliceTarget(stmt: ast.Stmt): string | undefined {
  if (stmt.$type !== "AssignStmt" || stmt.tok !== token.DEFINE || stmt.lhs.length !== 1 || stmt.rhs.length !== 1) {
    return undefined;
  }
  const target = stmt.lhs[0]!;
  if (target.$type !== "Ident" || target.name === "_") {
    return undefined;
  }
  // More than one nested append is reported as nested appends.
  return appendedSlices(stmt.rhs[0]!).length === 1 ? target.name : undefined;
}

// appendsToTarget reports whether stmt is target = append(target, s...).
function appendsToTarget(stmt: ast.Stmt, target: string): boolean {
  if (stmt.$type !== "AssignStmt" || stmt.tok !== token.ASSIGN || stmt.lhs.length !== 1 || stmt.rhs.length !== 1) {
    return false;
  }
  if (!isIdent(stmt.lhs[0], target)) {
    return false;
  }
  const call = stmt.rhs[0]!;
  if (call.$type !== "CallExpr" || !isVariadicAppend(call) || !isIdent(call.args[0], target)) {
    return false;
  }
  // slices.Concat cannot replace target = append(target, f(target)...), as the
  // replacement has yet to define target.
  return !usesIdent(call.args[1]!, target) && isSideEffectFree(call.args[1]!);
}

// isSideEffectFree reports whether evaluating expr cannot modify program
// state. slices.Concat copies the slices only once it has evaluated them all,
// so an appended slice that mutates earlier ones must not be reported.
function isSideEffectFree(expr: ast.Expr): boolean {
  switch (expr.$type) {
    case "Ident":
    case "BasicLit":
      return true;
    case "ParenExpr":
    case "StarExpr":
    case "SelectorExpr":
      return isSideEffectFree(expr.x!);
    case "IndexExpr":
      return isSideEffectFree(expr.x!) && isSideEffectFree(expr.index!);
    case "SliceExpr":
      return (
        isSideEffectFree(expr.x!) &&
        (expr.low === null || isSideEffectFree(expr.low)) &&
        (expr.high === null || isSideEffectFree(expr.high)) &&
        (expr.max === null || isSideEffectFree(expr.max))
      );
    case "CallExpr":
      // Only a conversion to a slice type, such as []byte(s), is not a call.
      return expr.fun!.$type === "ArrayType" && expr.args.length === 1 && isSideEffectFree(expr.args[0]!);
  }
  return false;
}

function usesIdent(expr: ast.Expr, name: string): boolean {
  return pickNodes(expr, (n) => n.$type === "Ident" && n.name === name).length > 0;
}

// appendedSlices returns the slices spread by nested appends into an empty
// slice literal, such as [s1, s2] for append(append([]T{}, s1...), s2...), or
// an empty list for any other expression.
function appendedSlices(expr: ast.Expr): ast.Expr[] {
  if (expr.$type !== "CallExpr" || !isVariadicAppend(expr)) {
    return [];
  }
  if (isEmptySliceLiteral(expr.args[0]!)) {
    return [expr.args[1]!];
  }
  const nested = appendedSlices(expr.args[0]!);
  return nested.length === 0 ? [] : [...nested, expr.args[1]!];
}

// isVariadicAppend reports whether call is append(s1, s2...). slices.Concat
// takes no string, so it excludes a spread string literal; telling other
// strings from slices takes type information, which revive does not use.
function isVariadicAppend(call: ast.CallExpr): boolean {
  if (!isIdent(call.fun, "append") || call.ellipsis === 0 || call.args.length !== 2) {
    return false;
  }
  return !isStringLiteral(call.args[1]);
}

function isEmptySliceLiteral(expr: ast.Expr): boolean {
  return expr.$type === "CompositeLit" && expr.elts.length === 0 && expr.type !== null && expr.type.$type === "ArrayType" && expr.type.len === null;
}
