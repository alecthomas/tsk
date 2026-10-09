import * as ast from "go/ast";
import * as parser from "go/parser";
import * as token from "go/token";
import { formatNode } from "tsk";

// Syn is an expression built by the analysis rather than parsed: an integer,
// arithmetic, or a call to len, min or max.
export type Syn =
  | { syn: "int"; value: number }
  | { syn: "binary"; x: Expr; op: token.Token; y: Expr }
  | { syn: "unary"; op: token.Token; x: Expr }
  | { syn: "call"; fun: string; args: Expr[] };

// Expr is a parsed expression, a built one, or a mix of the two.
export type Expr = ast.Expr | Syn;

export const isSyn = (e: Expr | ast.Node): e is Syn => "syn" in e;

export const intExpr = (value: number): Syn => ({ syn: "int", value });
export const callExpr = (fun: string, args: Expr[]): Syn => ({ syn: "call", fun, args });

// Shape is a view of an expression that treats built and parsed nodes alike.
type Shape =
  | { type: "Ident"; name: string }
  | { type: "BasicLit"; kind: token.Token; value: string }
  | { type: "BinaryExpr"; x: Expr | null; op: token.Token; y: Expr | null }
  | { type: "UnaryExpr"; op: token.Token; x: Expr | null }
  | { type: "CallExpr"; fun: string | null; parsedFun: ast.Expr | null; args: Expr[]; ellipsis: boolean }
  | { type: "Other"; node: ast.Expr };

export function shape(e: Expr): Shape {
  if (isSyn(e)) {
    switch (e.syn) {
      case "int":
        return { type: "BasicLit", kind: token.INT, value: String(e.value) };
      case "binary":
        return { type: "BinaryExpr", x: e.x, op: e.op, y: e.y };
      case "unary":
        return { type: "UnaryExpr", op: e.op, x: e.x };
      case "call":
        return { type: "CallExpr", fun: e.fun, parsedFun: null, args: e.args, ellipsis: false };
    }
  }
  switch (e.$type) {
    case "Ident":
      return { type: "Ident", name: e.name };
    case "BasicLit":
      return { type: "BasicLit", kind: e.kind, value: e.value };
    case "BinaryExpr":
      return { type: "BinaryExpr", x: e.x, op: e.op, y: e.y };
    case "UnaryExpr":
      return { type: "UnaryExpr", op: e.op, x: e.x };
    case "CallExpr":
      return {
        type: "CallExpr",
        fun: e.fun?.$type === "Ident" ? e.fun.name : null,
        parsedFun: e.fun,
        args: e.args as ast.Expr[],
        ellipsis: e.ellipsis !== token.NoPos,
      };
    default:
      return { type: "Other", node: e };
  }
}

const commutative = new Set([token.ADD, token.MUL, token.AND, token.OR, token.XOR, token.LAND, token.LOR, token.EQL, token.NEQ]);

// exprEqual compares expressions structurally, treating commutative operators
// as unordered.
export function exprEqual(x: Expr | null, y: Expr | null): boolean {
  if (x === null || y === null) {
    return x === y;
  }
  const a = shape(x);
  const b = shape(y);
  if (a.type === "Other" || b.type === "Other") {
    return a.type === "Other" && b.type === "Other" && nodeEqual(a.node, b.node);
  }
  if (a.type === "Ident" && b.type === "Ident") {
    return a.name === b.name;
  }
  if (a.type === "BasicLit" && b.type === "BasicLit") {
    return a.kind === b.kind && a.value === b.value;
  }
  if (a.type === "UnaryExpr" && b.type === "UnaryExpr") {
    return a.op === b.op && exprEqual(a.x, b.x);
  }
  if (a.type === "BinaryExpr" && b.type === "BinaryExpr") {
    if (a.op !== b.op) {
      return false;
    }
    return (exprEqual(a.x, b.x) && exprEqual(a.y, b.y)) || (commutative.has(a.op) && exprEqual(a.x, b.y) && exprEqual(a.y, b.x));
  }
  if (a.type === "CallExpr" && b.type === "CallExpr") {
    const funEqual = a.parsedFun !== null && b.parsedFun !== null ? exprEqual(a.parsedFun, b.parsedFun) : a.fun !== null && a.fun === b.fun;
    return funEqual && sliceEqual(a.args, b.args) && a.ellipsis === b.ellipsis;
  }
  return false;
}

function sliceEqual(xs: readonly (Expr | null)[], ys: readonly (Expr | null)[]): boolean {
  return xs.length === ys.length && xs.every((x, i) => exprEqual(x, ys[i]));
}

function fieldListEqual(x: ast.FieldList | null, y: ast.FieldList | null): boolean {
  if (x === null || y === null) {
    return x === y;
  }
  return (
    x.list.length === y.list.length &&
    x.list.every((f, i) => {
      const g = y.list[i]!;
      return f!.names.length === g.names.length && f!.names.every((n, j) => n!.name === g.names[j]!.name) && exprEqual(f!.type, g.type);
    })
  );
}

function funcTypeEqual(x: ast.FuncType | null, y: ast.FuncType | null): boolean {
  if (x === null || y === null) {
    return x === y;
  }
  return fieldListEqual(x.params, y.params) && fieldListEqual(x.results, y.results) && fieldListEqual(x.typeParams, y.typeParams);
}

// nodeEqual compares the parsed expressions shape does not cover.
function nodeEqual(x: ast.Expr, y: ast.Expr): boolean {
  if (x.$type !== y.$type) {
    return false;
  }
  switch (x.$type) {
    case "FuncLit":
      return funcTypeEqual(x.type, (y as ast.FuncLit).type);
    case "CompositeLit":
      return exprEqual(x.type, (y as ast.CompositeLit).type) && sliceEqual(x.elts, (y as ast.CompositeLit).elts);
    case "ParenExpr":
      return exprEqual(x.x, (y as ast.ParenExpr).x);
    case "StarExpr":
      return exprEqual(x.x, (y as ast.StarExpr).x);
    case "SelectorExpr":
      return exprEqual(x.x, (y as ast.SelectorExpr).x) && x.sel?.name === (y as ast.SelectorExpr).sel?.name;
    case "IndexExpr":
      return exprEqual(x.x, (y as ast.IndexExpr).x) && exprEqual(x.index, (y as ast.IndexExpr).index);
    case "IndexListExpr":
      return exprEqual(x.x, (y as ast.IndexListExpr).x) && sliceEqual(x.indices, (y as ast.IndexListExpr).indices);
    case "SliceExpr": {
      const s = y as ast.SliceExpr;
      return exprEqual(x.x, s.x) && exprEqual(x.low, s.low) && exprEqual(x.high, s.high) && exprEqual(x.max, s.max);
    }
    case "TypeAssertExpr":
      return exprEqual(x.x, (y as ast.TypeAssertExpr).x) && exprEqual(x.type, (y as ast.TypeAssertExpr).type);
    case "KeyValueExpr":
      return exprEqual(x.key, (y as ast.KeyValueExpr).key) && exprEqual(x.value, (y as ast.KeyValueExpr).value);
    case "ArrayType":
      return exprEqual(x.len, (y as ast.ArrayType).len) && exprEqual(x.elt, (y as ast.ArrayType).elt);
    case "StructType":
      return fieldListEqual(x.fields, (y as ast.StructType).fields);
    case "FuncType":
      return funcTypeEqual(x, y as ast.FuncType);
    case "InterfaceType":
      return fieldListEqual(x.methods, (y as ast.InterfaceType).methods);
    case "MapType":
      return exprEqual(x.key, (y as ast.MapType).key) && exprEqual(x.value, (y as ast.MapType).value);
    case "ChanType":
      return x.dir === (y as ast.ChanType).dir && exprEqual(x.value, (y as ast.ChanType).value);
    case "Ellipsis":
      return exprEqual(x.elt, (y as ast.Ellipsis).elt);
    default:
      return false;
  }
}

function children(e: Syn): Expr[] {
  switch (e.syn) {
    case "int":
      return [];
    case "binary":
      return [e.x, e.y];
    case "unary":
      return [e.x];
    case "call":
      return e.args;
  }
}

// inspect visits an expression and its subexpressions in preorder, through
// parsed and built nodes alike. Returning false skips a node's children.
export function inspect(e: Expr | null, f: (node: Expr | ast.Node) => boolean): void {
  if (e === null) {
    return;
  }
  if (!isSyn(e)) {
    ast.inspect(e, (node) => node === null || f(node));
    return;
  }
  if (f(e)) {
    for (const child of children(e)) {
      inspect(child, f);
    }
  }
}

// format prints an expression as go/format would. A built expression is
// written as source and parsed again for the printer to lay out. Parentheses
// go only where precedence needs them, which is where the printer adds them.
export function format(e: Expr): string | null {
  if (!isSyn(e)) {
    return formatNode(e);
  }
  try {
    const parsed = parser.parseExpr(source(e));
    return parsed === null ? null : formatNode(parsed);
  } catch {
    return null;
  }
}

function precedence(e: Expr): number {
  const s = shape(e);
  return s.type === "BinaryExpr" ? token.Token.precedence(s.op) : token.UnaryPrec + 1;
}

function source(e: Expr): string {
  if (!isSyn(e)) {
    return formatNode(e);
  }
  switch (e.syn) {
    case "int":
      return String(e.value);
    case "call":
      return `${e.fun}(${e.args.map(source).join(", ")})`;
    case "unary": {
      const operand = shape(e.x).type;
      // A space keeps two operators from merging into one token.
      const x = operand === "BinaryExpr" ? `(${source(e.x)})` : operand === "UnaryExpr" ? ` ${source(e.x)}` : source(e.x);
      return `${token.Token.string(e.op)}${x}`;
    }
    case "binary": {
      const prec = token.Token.precedence(e.op);
      const left = precedence(e.x) < prec ? `(${source(e.x)})` : source(e.x);
      const right = precedence(e.y) <= prec ? `(${source(e.y)})` : source(e.y);
      return `${left} ${token.Token.string(e.op)} ${right}`;
    }
  }
}
