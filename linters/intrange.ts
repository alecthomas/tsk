import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

const message = "for loop can be changed to use an integer range (Go 1.22+)";

const intCasts = new Set(["int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64"]);

export default defineAnalyzer({
  name: "intrange",
  doc: "intrange is a linter to find places where for loops could make use of an integer range.",
  requires: [inspect],
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.ForStmt, ast.RangeStmt)) {
      const node = cursor.node()!;
      if (node.$type === "ForStmt") {
        checkFor(pass, node);
      } else if (node.$type === "RangeStmt") {
        checkRange(pass, node);
      }
    }
  },
});

// Loop is a counting loop's variable and bound, as in i := 0; i < n; i++.
interface Loop {
  ident: ast.Ident;
  operand: ast.Expr;
  // inclusive is set for a bound compared with <= or >=.
  inclusive: boolean;
}

function checkFor(pass: Pass<unknown>, stmt: ast.ForStmt): void {
  const loop = countingLoop(stmt);
  if (loop === null) {
    return;
  }
  const { ident, operand, inclusive } = loop;
  const usage = bodyUsage(stmt.body!, ident, boundExpr(operand));
  if (usage.modified) {
    return;
  }
  if ((stmt.init as ast.AssignStmt).tok === token.ASSIGN) {
    pass.report({
      pos: stmt.pos(),
      message: `${message}\nBecause the key is not part of the loop's scope, take care to consider side effects.`,
    });
    return;
  }
  const operandIsNumber = isNumberLit(operand);
  if (inclusive && !operandIsNumber) {
    return;
  }
  if (isFunctionOrMethodCall(operand)) {
    pass.report({
      pos: stmt.pos(),
      message: `${message}\nBecause the key is returned by a function or method, take care to consider side effects.`,
    });
    return;
  }
  const rangeX = operandString(pass, ident, operand, inclusive && operandIsNumber);
  const replacement = usage.accessed ? `${ident.name} := range ${rangeX}` : `range ${rangeX}`;
  pass.report({
    pos: stmt.pos(),
    message,
    suggestedFixes: [
      {
        message: `Replace loop with \`${replacement}\``,
        textEdits: [{ pos: stmt.init!.pos(), end: stmt.post!.end(), newText: replacement }],
      },
    ],
  });
}

// countingLoop matches a loop that counts up from zero in steps of one.
function countingLoop(stmt: ast.ForStmt): Loop | null {
  const init = stmt.init;
  if (init?.$type !== "AssignStmt" || stmt.cond?.$type !== "BinaryExpr" || stmt.post === null) {
    return null;
  }
  if (init.lhs.length !== 1 || init.rhs.length !== 1) {
    return null;
  }
  const ident = init.lhs[0];
  if (ident?.$type !== "Ident" || !compareNumberLit(init.rhs[0], 0)) {
    return null;
  }
  const cond = stmt.cond;
  let operand: ast.Expr | null;
  let inclusive: boolean;
  if (cond.op === token.LSS || cond.op === token.LEQ) {
    if (!isIdent(cond.x, ident.name)) {
      return null;
    }
    inclusive = cond.op === token.LEQ;
    operand = cond.y;
  } else if (cond.op === token.GTR || cond.op === token.GEQ) {
    if (!isIdent(cond.y, ident.name)) {
      return null;
    }
    inclusive = cond.op === token.GEQ;
    operand = cond.x;
  } else {
    return null;
  }
  if (operand === null || !incrementsByOne(stmt.post, ident.name)) {
    return null;
  }
  return { ident, operand, inclusive };
}

// incrementsByOne matches i++, i += 1, i = i + 1, and i = 1 + i.
function incrementsByOne(post: ast.Stmt, name: string): boolean {
  if (post.$type === "IncDecStmt") {
    return post.tok === token.INC && isIdent(post.x, name);
  }
  if (post.$type !== "AssignStmt" || post.lhs.length !== 1 || post.rhs.length !== 1 || !isIdent(post.lhs[0], name)) {
    return false;
  }
  const rhs = post.rhs[0];
  if (post.tok === token.ADD_ASSIGN) {
    return compareNumberLit(rhs, 1);
  }
  if (post.tok !== token.ASSIGN || rhs?.$type !== "BinaryExpr" || rhs.op !== token.ADD) {
    return false;
  }
  if (rhs.x?.$type === "Ident") {
    return rhs.x.name === name && compareNumberLit(rhs.y, 1);
  }
  return rhs.x?.$type === "BasicLit" && compareNumberLit(rhs.x, 1) && isIdent(rhs.y, name);
}

function checkRange(pass: Pass<unknown>, stmt: ast.RangeStmt): void {
  if (stmt.value !== null) {
    return;
  }
  let pos = stmt.range;
  let key: string | null = null;
  if (stmt.key !== null) {
    if (stmt.key.$type !== "Ident") {
      return;
    }
    pos = stmt.key.pos();
    key = stmt.key.name === "_" ? null : stmt.key.name;
  }
  const x = stmt.x;
  if (x?.$type !== "CallExpr" || !isLen(x)) {
    return;
  }
  const arg = x.args[0];
  if (arg?.$type !== "Ident") {
    return;
  }
  const underlying = pass.typesInfo.objectOf(arg)?.type()?.underlying();
  if (underlying?.$type !== "Slice" && underlying?.$type !== "Array") {
    return;
  }
  const fix = { message: `Replace \`len(${arg.name})\` with \`${arg.name}\`` };
  if (key !== null) {
    pass.report({
      pos,
      end: x.end(),
      message: `for loop can be changed to \`${key} := range ${arg.name}\``,
      suggestedFixes: [{ ...fix, textEdits: [{ pos: x.pos(), end: x.end(), newText: arg.name }] }],
    });
    return;
  }
  pass.report({
    pos,
    end: x.end(),
    message: `for loop can be changed to \`range ${arg.name}\``,
    suggestedFixes: [{ ...fix, textEdits: [{ pos, end: x.end(), newText: `range ${arg.name}` }] }],
  });
}

// boundExpr returns the variable a loop bound reads, which the body must not
// modify, such as n in len(n).
function boundExpr(expr: ast.Expr | null): ast.Expr | null {
  switch (expr?.$type) {
    case "CallExpr":
      return isLen(expr) ? boundExpr(expr.args[0]) : null;
    case "Ident":
    case "SelectorExpr":
    case "IndexExpr":
      return expr;
    default:
      return null;
  }
}

// bodyUsage reports whether a loop body modifies the loop variable or bound,
// and whether it mentions the loop variable.
function bodyUsage(body: ast.BlockStmt, ident: ast.Ident, bound: ast.Expr | null): { modified: boolean; accessed: boolean } {
  let modified = false;
  let accessed = false;
  const touches = (expr: ast.Expr | null) => sameExpr(expr, ident) || sameExpr(expr, bound);
  ast.inspect(body, (node) => {
    if (node?.$type === "AssignStmt" && node.lhs.some(touches)) {
      modified = true;
    } else if (node?.$type === "IncDecStmt" && touches(node.x)) {
      modified = true;
    } else if (node?.$type === "Ident" && node.name === ident.name) {
      accessed = true;
    }
    return !modified;
  });
  return { modified, accessed };
}

// sameExpr compares expressions by name, matching upstream's identEqual: an
// index expression also matches its indexed operand.
function sameExpr(a: ast.Expr | null, b: ast.Expr | null): boolean {
  if (a === null || b === null) {
    return false;
  }
  switch (a.$type) {
    case "Ident":
      return b.$type === "Ident" && a.name === b.name;
    case "SelectorExpr":
      return b.$type === "SelectorExpr" && sameExpr(a.sel, b.sel) && sameExpr(a.x, b.x);
    case "IndexExpr":
      return b.$type === "IndexExpr" ? sameExpr(a.x, b.x) && sameExpr(a.index, b.index) : sameExpr(a.x, b);
    case "BasicLit":
      return b.$type === "BasicLit" && a.value === b.value;
    default:
      return false;
  }
}

function isIdent(expr: ast.Expr | null, name: string): boolean {
  return expr?.$type === "Ident" && expr.name === name;
}

function isLen(call: ast.CallExpr): boolean {
  return isIdent(call.fun, "len") && call.args.length === 1;
}

// unwrapIntCast strips a single conversion such as int64(n), returning null
// for other calls.
function unwrapIntCast(expr: ast.CallExpr): ast.Expr | null {
  return expr.fun?.$type === "Ident" && intCasts.has(expr.fun.name) && expr.args.length === 1 ? expr.args[0] : null;
}

function isNumberLit(expr: ast.Expr | null): boolean {
  if (expr?.$type === "BasicLit") {
    return expr.kind === token.INT;
  }
  return expr?.$type === "CallExpr" && isNumberLit(unwrapIntCast(expr));
}

// compareNumberLit matches an integer literal written as decimal or hex
// digits, as upstream does, so 0x10 matches 10.
function compareNumberLit(expr: ast.Expr | null, value: number): boolean {
  if (expr?.$type === "BasicLit") {
    const n = String(value);
    return expr.kind === token.INT && [n, `0x${n}`, `0X${n}`].includes(expr.value);
  }
  return expr?.$type === "CallExpr" && compareNumberLit(unwrapIntCast(expr), value);
}

function isFunctionOrMethodCall(expr: ast.Expr): boolean {
  if (expr.$type !== "CallExpr") {
    return false;
  }
  return expr.fun?.$type !== "Ident" || !(isLen(expr) || intCasts.has(expr.fun.name));
}

// operandString renders the range operand, converting it to the loop
// variable's type when that differs from the operand's.
function operandString(pass: Pass<unknown>, ident: ast.Ident, operand: ast.Expr, increment: boolean): string {
  const s = exprString(operand, increment);
  const t = pass.typesInfo.typeOf(ident);
  if (t?.$type === "Basic" && t.kind() === types.Int) {
    return s.length > 5 && s.startsWith("int(") && s.endsWith(")") ? s.slice(4, -1) : s;
  }
  if (s.length > 2 && s.endsWith(")")) {
    return s;
  }
  if (operand.$type === "Ident" && t !== null && pass.typesInfo.typeOf(operand) === t) {
    return s;
  }
  return `${t?.string() ?? "<nil>"}(${s})`;
}

// exprString prints the expressions a loop bound may hold, adding one to an
// integer literal for an inclusive bound.
function exprString(expr: ast.Expr | null, increment: boolean): string {
  switch (expr?.$type) {
    case "CallExpr": {
      const args = expr.args.map((arg) => exprString(arg, increment && expr.args.length === 1));
      return `${exprString(expr.fun, false)}(${args.join(", ")})`;
    }
    case "BasicLit":
      if (increment && expr.kind === token.INT && /^[+-]?\d+$/.test(expr.value)) {
        return String(Number(expr.value) + 1);
      }
      return expr.value;
    case "Ident":
      return expr.name;
    case "SelectorExpr":
      return `${exprString(expr.x, false)}.${exprString(expr.sel, false)}`;
    case "IndexExpr":
      return `${exprString(expr.x, false)}[${exprString(expr.index, false)}]`;
    case "BinaryExpr":
      return `${exprString(expr.x, false)} ${token.Token.string(expr.op)} ${exprString(expr.y, false)}`;
    case "StarExpr":
      return `*${exprString(expr.x, false)}`;
    default:
      return "";
  }
}
