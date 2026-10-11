// Port of golang.org/x/tools/go/analysis/passes/bools at v0.50.0.
import * as ast from "go/ast";
import * as token from "go/token";
import type * as types from "go/types";
import { defineAnalyzer, formatNode, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { noEffects } from "./internal/typesinternal";

interface BoolOp {
  name: string;
  tok: token.Token;
  tokString: string;
  // The equality test that should not be used with this operator.
  badEq: token.Token;
}

const or: BoolOp = { name: "or", tok: token.LOR, tokString: "||", badEq: token.NEQ };
const and: BoolOp = { name: "and", tok: token.LAND, tokString: "&&", badEq: token.EQL };

export default defineAnalyzer({
  name: "bools",
  doc: "check for common mistakes involving boolean operators",
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/bools",
  requires: [inspect],
  run(pass) {
    const seen = new Set<ast.BinaryExpr>();
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.BinaryExpr)) {
      const e = cursor.node() as ast.BinaryExpr;
      if (seen.has(e)) {
        // Already processed as a subexpression of an earlier node.
        continue;
      }
      let op: BoolOp;
      if (e.op === token.LOR) {
        op = or;
      } else if (e.op === token.LAND) {
        op = and;
      } else {
        continue;
      }
      for (const exprs of commutativeSets(pass.typesInfo, op, e, seen)) {
        checkRedundant(pass, op, exprs);
        checkSuspect(pass, op, exprs);
      }
    }
  },
});

// commutativeSets returns the side effect free runs of the operands of e
// connected by op, adding each expanded BinaryExpr to seen.
function commutativeSets(info: types.Info, op: BoolOp, e: ast.BinaryExpr, seen: Set<ast.BinaryExpr>): ast.Expr[][] {
  const exprs = split(op, e, seen);
  let i = 0;
  const sets: ast.Expr[][] = [];
  for (let j = 0; j <= exprs.length; j++) {
    if (j === exprs.length || !noEffects(info, exprs[j]!)) {
      if (i < j) {
        sets.push(exprs.slice(i, j));
      }
      i = j + 1;
    }
  }
  return sets;
}

// checkRedundant reports expressions of the form e && e or e || e.
function checkRedundant(pass: Pass<unknown>, op: BoolOp, exprs: ast.Expr[]): void {
  const seen = new Set<string>();
  for (const e of exprs) {
    const efmt = formatNode(e, pass.fset);
    if (seen.has(efmt)) {
      pass.report({ pos: e.pos(), end: e.end(), message: `redundant ${op.name}: ${efmt} ${op.tokString} ${efmt}` });
    } else {
      seen.add(efmt);
    }
  }
}

// checkSuspect reports x != c1 || x != c2 and x == c1 && x == c2, where c1
// and c2 are constant.
function checkSuspect(pass: Pass<unknown>, op: BoolOp, exprs: ast.Expr[]): void {
  // Maps expressions x to equality expressions x != c.
  const seen = new Map<string, string>();
  for (const e of exprs) {
    if (e.$type !== "BinaryExpr" || e.op !== op.badEq) {
      continue;
    }
    // Restrict to cases in which one operand is constant, to avoid false
    // positives, and look at the other operand.
    let x: ast.Expr;
    if ((pass.typesInfo.types.get(e.y!)?.value ?? null) !== null) {
      x = e.x!;
    } else if ((pass.typesInfo.types.get(e.x!)?.value ?? null) !== null) {
      x = e.y!;
    } else {
      continue;
    }
    const xfmt = formatNode(x, pass.fset);
    const efmt = formatNode(e, pass.fset);
    const prev = seen.get(xfmt);
    if (prev !== undefined) {
      // checkRedundant handles efmt === prev.
      if (efmt !== prev) {
        pass.report({ pos: e.pos(), end: e.end(), message: `suspect ${op.name}: ${efmt} ${op.tokString} ${prev}` });
      }
    } else {
      seen.set(xfmt, efmt);
    }
  }
}

// split returns the subexpressions of e connected by op, last first, adding
// each expanded BinaryExpr to seen.
function split(op: BoolOp, e: ast.Expr, seen: Set<ast.BinaryExpr>): ast.Expr[] {
  const exprs: ast.Expr[] = [];
  for (;;) {
    e = ast.unparen(e)!;
    if (e.$type === "BinaryExpr" && e.op === op.tok) {
      seen.add(e);
      exprs.push(...split(op, e.y!, seen));
      e = e.x!;
    } else {
      exprs.push(e);
      break;
    }
  }
  return exprs;
}
