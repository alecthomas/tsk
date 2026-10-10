import type * as ast from "go/ast";
import { isPkgDotName, seekNode, walk, type Visitor } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "use-waitgroup-go";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  if (!file.pkg.isAtLeastGoVersion("1.25")) {
    return [];
  }
  const failures: Failure[] = [];
  const visitor: Visitor = {
    visit(node) {
      if (node !== null && node.$type === "BlockStmt") {
        analyzeBlock(node, failures);
      }
      return visitor;
    },
  };
  for (const decl of file.ast.decls) {
    if (decl?.$type === "FuncDecl" && decl.body !== null) {
      walk(visitor, decl.body);
    }
  }
  return failures;
}

// analyzeBlock reports each wg.Add followed, later in the block, by a go
// statement running a function literal that calls wg.Done. Like revive, it
// matches only a WaitGroup named wg.
function analyzeBlock(block: ast.BlockStmt, failures: Failure[]): void {
  const stmts = block.list;
  for (let i = 0; i < stmts.length; i++) {
    const call = stmts[i]!;
    if (!isCallToWgAdd(call)) {
      continue;
    }
    for (i++; i < stmts.length; i++) {
      if (findGoStmtWithWgDone(stmts[i]!)) {
        failures.push({ failure: "replace wg.Add()...go {...wg.Done()...} with wg.Go(...)", node: call, confidence: 1 });
        break;
      }
    }
  }
}

// findGoStmtWithWgDone looks in stmt and one level into loop bodies.
function findGoStmtWithWgDone(stmt: ast.Stmt): boolean {
  switch (stmt.$type) {
    case "GoStmt":
      return hasCallToWgDone(stmt);
    case "ForStmt":
    case "RangeStmt":
      return stmt.body !== null && stmt.body.list.some((s) => s!.$type === "GoStmt" && hasCallToWgDone(s));
  }
  return false;
}

function hasCallToWgDone(goStmt: ast.GoStmt): boolean {
  const fun = goStmt.call!.fun!;
  if (fun.$type !== "FuncLit") {
    return false;
  }
  return seekNode(fun.body, (n) => n.$type === "CallExpr" && isPkgDotName(n.fun, "wg", "Done")) !== null;
}

function isCallToWgAdd(stmt: ast.Stmt): boolean {
  return stmt.$type === "ExprStmt" && stmt.x!.$type === "CallExpr" && isPkgDotName(stmt.x.fun, "wg", "Add");
}
