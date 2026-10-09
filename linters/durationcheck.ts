import * as ast from "go/ast";
import * as token from "go/token";
import type * as types from "go/types";
import { defineAnalyzer, formatNode, type Pass } from "tsk";
import { inspect } from "tsk/passes";

export default defineAnalyzer({
  name: "durationcheck",
  doc: `check for two durations multiplied together

Multiplying two time.Durations squares the unit, so d * time.Second with d
already a duration is almost always a bug. Constants and conversions such as
time.Duration(n) are accepted as plain numbers.`,
  requires: [inspect],
  run(pass) {
    if (!pass.pkg.imports().some((pkg) => pkg!.path() === "time")) {
      return;
    }
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.BinaryExpr, ast.AssignStmt)) {
      const node = cursor.node()!;
      if (node.$type === "BinaryExpr" && node.op === token.MUL) {
        check(pass, node, node.x!, node.y!, () => formatNode(node));
      } else if (node.$type === "AssignStmt" && node.tok === token.MUL_ASSIGN && node.lhs.length === 1 && node.rhs.length === 1) {
        const [x, y] = [node.lhs[0]!, node.rhs[0]!];
        // Upstream formats x *= y as a binary expression, which prints y one
        // level deeper, as go/printer does the right operand.
        check(pass, node, x, y, () => `${formatNode(x)} *= ${formatOperand(y, 2)}`);
      }
    }
  },
});

function check(pass: Pass<unknown>, node: ast.Node, x: ast.Expr, y: ast.Expr, text: () => string): void {
  const xType = pass.typesInfo.types.get(x)?.type ?? null;
  const yType = pass.typesInfo.types.get(y)?.type ?? null;
  if (isDuration(xType) && isDuration(yType) && !isAcceptable(pass, x) && !isAcceptable(pass, y)) {
    pass.report({ pos: node.pos(), message: `Multiplication of durations: \`${text()}\`` });
  }
}

// formatOperand formats an operand as go/printer does at a nesting depth,
// where binary operators lose their surrounding blanks. Binary, unary, and
// parenthesized expressions are followed; others format as they would alone.
function formatOperand(expr: ast.Expr, depth: number): string {
  switch (expr.$type) {
    case "BinaryExpr": {
      const prec = token.Token.precedence(expr.op);
      const blank = prec < cutoff(expr, depth) ? " " : "";
      const sameLevel = expr.x?.$type === "BinaryExpr" && token.Token.precedence(expr.x.op) === prec;
      const x = formatOperand(expr.x!, depth + (sameLevel ? 0 : 1));
      const y = formatOperand(expr.y!, depth + 1);
      return `${x}${blank}${token.Token.string(expr.op)}${blank}${y}`;
    }
    case "UnaryExpr":
      return token.Token.string(expr.op) + formatOperand(expr.x!, depth);
    case "ParenExpr":
      return `(${formatOperand(expr.x!, Math.max(depth - 1, 1))})`;
  }
  return formatNode(expr);
}

// cutoff is go/printer's precedence below which operators get blanks.
function cutoff(expr: ast.BinaryExpr, depth: number): number {
  const [has4, has5, maxProblem] = walkBinary(expr);
  if (maxProblem > 0) {
    return maxProblem + 1;
  }
  if (has4 && has5) {
    return depth === 1 ? 5 : 4;
  }
  return depth === 1 ? 6 : 4;
}

function walkBinary(expr: ast.BinaryExpr): [boolean, boolean, number] {
  const prec = token.Token.precedence(expr.op);
  let has4 = prec === 4;
  let has5 = prec === 5;
  let maxProblem = 0;
  const merge = (child: ast.BinaryExpr) => {
    const [h4, h5, problem] = walkBinary(child);
    has4 ||= h4;
    has5 ||= h5;
    maxProblem = Math.max(maxProblem, problem);
  };
  if (expr.x?.$type === "BinaryExpr" && token.Token.precedence(expr.x.op) >= prec) {
    merge(expr.x);
  }
  const y = expr.y;
  if (y?.$type === "BinaryExpr" && token.Token.precedence(y.op) > prec) {
    merge(y);
  } else if (y?.$type === "StarExpr" && expr.op === token.QUO) {
    maxProblem = 5;
  } else if (y?.$type === "UnaryExpr") {
    const pair = token.Token.string(expr.op) + token.Token.string(y.op);
    if (pair === "/*" || pair === "&&" || pair === "&^") {
      maxProblem = 5;
    } else if ((pair === "++" || pair === "--") && maxProblem < 4) {
      maxProblem = 4;
    }
  }
  return [has4, has5, maxProblem];
}

function isDuration(t: types.Type | null): boolean {
  const name = t?.string();
  return name === "time.Duration" || name === "*time.Duration";
}

// isAcceptable reports whether an operand of a duration multiplication may
// itself be a duration, as a literal or a conversion such as time.Duration(n).
function isAcceptable(pass: Pass<unknown>, expr: ast.Expr): boolean {
  switch (expr.$type) {
    case "BasicLit":
      return true;
    case "CallExpr":
      return isAcceptableCast(pass, expr);
    case "Ident":
    case "BinaryExpr":
    case "UnaryExpr":
    case "SelectorExpr":
    case "StarExpr":
    case "ParenExpr":
    case "IndexExpr":
      return isAcceptableNested(pass, expr);
  }
  return false;
}

function isAcceptableCast(pass: Pass<unknown>, call: ast.CallExpr): boolean {
  if (call.args.length !== 1 || !isAcceptableNested(pass, call.args[0]!)) {
    return false;
  }
  const fun = call.fun;
  return fun?.$type === "SelectorExpr" && fun.x?.$type === "Ident" && fun.x.name === "time" && fun.sel!.name === "Duration";
}

// isAcceptableNested reports whether an expression involves no duration
// values, apart from literals and conversions.
function isAcceptableNested(pass: Pass<unknown>, expr: ast.Expr | null): boolean {
  switch (expr?.$type) {
    case "BasicLit":
      return true;
    case "BinaryExpr":
      return isAcceptableNested(pass, expr.x) && isAcceptableNested(pass, expr.y);
    case "UnaryExpr":
    case "StarExpr":
    case "ParenExpr":
      return isAcceptableNested(pass, expr.x);
    case "Ident":
      return isAcceptableIdent(pass, expr);
    case "CallExpr":
      return isAcceptableCast(pass, expr) || !isDuration(pass.typesInfo.typeOf(expr));
    case "SelectorExpr":
      return isAcceptableNested(pass, expr.x) && isAcceptableIdent(pass, expr.sel!);
    case "IndexExpr":
      return !isDuration(pass.typesInfo.typeOf(expr));
  }
  return false;
}

function isAcceptableIdent(pass: Pass<unknown>, ident: ast.Ident): boolean {
  return !isDuration(pass.typesInfo.objectOf(ident)?.type() ?? null);
}
