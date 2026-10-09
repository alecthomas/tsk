import * as token from "go/token";
import { type Expr, exprEqual, intExpr, type Syn, shape } from "./expr";

const conversions = new Set(["byte", "rune", "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr"]);

// intValue returns the integer a constant expression spells out, looking
// through negation and integer conversions.
export function intValue(expr: Expr | null): number | null {
  let negate = false;
  let e = expr;
  for (;;) {
    if (e === null) {
      return null;
    }
    const s = shape(e);
    if (s.type === "UnaryExpr" && s.op === token.SUB) {
      negate = !negate;
      e = s.x;
      continue;
    }
    if (s.type === "CallExpr" && s.fun !== null && s.args.length === 1 && conversions.has(s.fun)) {
      e = s.args[0];
      continue;
    }
    break;
  }
  const s = shape(e);
  // Like strconv.Atoi: decimal digits with an optional sign.
  if (s.type !== "BasicLit" || s.kind !== token.INT || !/^[+-]?\d+$/.test(s.value)) {
    return null;
  }
  const n = Number(s.value);
  return negate ? -n : n;
}

const binary = (x: Expr, op: token.Token, y: Expr): Syn => ({ syn: "binary", x, op, y });

export function addIntExpr(x: Expr | null, y: Expr | null): Expr | null {
  if (x === null || y === null) {
    return null;
  }
  const xi = intValue(x);
  const yi = intValue(y);
  if (xi !== null && yi !== null) {
    return intExpr(xi + yi);
  }
  if (xi !== null) {
    if (xi === 0) {
      return y;
    }
    if (xi < 0) {
      return binary(y, token.SUB, intExpr(-xi));
    }
  }
  if (yi !== null) {
    if (yi === 0) {
      return x;
    }
    if (yi < 0) {
      return binary(x, token.SUB, intExpr(-yi));
    }
  }
  const ys = shape(y);
  if (ys.type === "UnaryExpr" && ys.op === token.SUB) {
    return binary(x, token.SUB, ys.x!);
  }
  return binary(x, token.ADD, y);
}

export function incIntExpr(x: Expr | null): Expr | null {
  if (x === null) {
    return null;
  }
  const xi = intValue(x);
  if (xi !== null) {
    return intExpr(xi + 1);
  }
  const s = shape(x);
  if (s.type === "BinaryExpr" && s.op === token.SUB && intValue(s.y) === 1) {
    return s.x;
  }
  return binary(x, token.ADD, intExpr(1));
}

export function subIntExpr(x: Expr | null, y: Expr | null): Expr | null {
  const xs = x === null ? null : shape(x);
  if (xs?.type === "BinaryExpr" && xs.op === token.ADD) {
    if (exprEqual(xs.x, y)) {
      return xs.y;
    }
    if (exprEqual(xs.y, y)) {
      return xs.x;
    }
  }
  if (y === null) {
    return null;
  }
  const ys = shape(y);
  return addIntExpr(x, ys.type === "UnaryExpr" && ys.op === token.SUB ? ys.x : { syn: "unary", op: token.SUB, x: y });
}

export function mulIntExpr(x: Expr | null, y: Expr | null): Expr | null {
  if (x === null || y === null) {
    return null;
  }
  const xi = intValue(x);
  const yi = intValue(y);
  if (xi !== null && yi !== null) {
    return intExpr(xi * yi);
  }
  if (xi === 0 || yi === 0) {
    return intExpr(0);
  }
  if (xi === 1) {
    return y;
  }
  if (yi === 1) {
    return x;
  }
  return binary(x, token.MUL, y);
}

// divIntExpr divides, reporting whether the result may be rounded down.
export function divIntExpr(x: Expr | null, y: Expr | null): { expr: Expr | null; rounded: boolean } {
  if (x === null || y === null) {
    return { expr: null, rounded: false };
  }
  const xi = intValue(x);
  const yi = intValue(y);
  if (xi !== null && yi !== null) {
    // Upstream panics dividing by a zero step.
    return yi === 0 ? { expr: null, rounded: false } : { expr: intExpr(Math.trunc(xi / yi)), rounded: xi % yi !== 0 };
  }
  if (yi === 0) {
    return { expr: null, rounded: false };
  }
  if (xi === 0 || yi === 1) {
    return { expr: x, rounded: false };
  }
  return { expr: binary(x, token.QUO, y), rounded: true };
}
