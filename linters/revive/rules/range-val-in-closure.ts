import * as ast from "go/ast";
import { walk, type Visitor } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "range-val-in-closure";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  if (file.pkg.isAtLeastGoVersion("1.22")) {
    return [];
  }
  const failures: Failure[] = [];
  const visitor: Visitor = {
    visit(node) {
      if (node !== null) {
        check(node, failures);
      }
      return visitor;
    },
  };
  walk(visitor, file.ast);
  return failures;
}

function check(node: ast.Node, failures: Failure[]): void {
  // The variables the loop statement updates.
  const vars: ast.Ident[] = [];
  const addVar = (expr: ast.Expr | null) => {
    if (expr !== null && expr.$type === "Ident") {
      vars.push(expr);
    }
  };
  let body: ast.BlockStmt;
  if (node.$type === "RangeStmt") {
    body = node.body!;
    addVar(node.key);
    addVar(node.value);
  } else if (node.$type === "ForStmt") {
    body = node.body!;
    const post = node.post;
    if (post?.$type === "AssignStmt") {
      post.lhs.forEach(addVar);
    } else if (post?.$type === "IncDecStmt") {
      addVar(post.x);
    }
  } else {
    return;
  }
  if (vars.length === 0 || body.list.length === 0) {
    return;
  }
  // Only a go or defer statement that ends the body: a statement after it
  // may wait for the goroutine or return.
  const last = body.list[body.list.length - 1]!;
  if (last.$type !== "GoStmt" && last.$type !== "DeferStmt") {
    return;
  }
  const lit = last.call!.fun!;
  if (lit.$type !== "FuncLit" || lit.type === null) {
    return;
  }
  const inspector = (n: ast.Node | null): boolean => {
    if (n === null) {
      return true;
    }
    if (n.$type === "KeyValueExpr") {
      // Keys of key-value expressions are not variables (revive issue #637).
      ast.inspect(n.value!, inspector);
      return false;
    }
    if (n.$type !== "Ident" || n.obj === null) {
      return true;
    }
    for (const v of vars) {
      if (v.obj === n.obj) {
        failures.push({ failure: `loop variable ${n.name} captured by func literal`, node: n, confidence: 1 });
      }
    }
    return true;
  };
  ast.inspect(lit.body!, inspector);
}
