import type * as ast from "go/ast";
import { defineAnalyzer, type Pass } from "tsk";

interface Config {
  /** The most lines a function may span, not counting its braces. 0 means 60; negative disables the check. */
  lines: number;
  /** The most statements a function may hold. 0 means 40; negative disables the check. */
  statements: number;
  /** Do not count comment lines. */
  ignoreComments: boolean;
}

export default defineAnalyzer<Config>({
  name: "funlen",
  doc: `check for long functions

Reports functions with too many lines or statements. Statements in nested
blocks and in function literals that are assigned, deferred, or started as
goroutines count towards their function.`,
  url: "https://github.com/ultraware/funlen",
  config: { lines: 60, statements: 40, ignoreComments: true },
  run(pass) {
    const lineLimit = pass.config.lines === 0 ? 60 : pass.config.lines;
    const stmtLimit = pass.config.statements === 0 ? 40 : pass.config.statements;
    for (const file of pass.files) {
      for (const decl of file.decls) {
        if (decl?.$type !== "FuncDecl" || decl.body === null) {
          continue;
        }
        const name = decl.name!.name;
        if (stmtLimit > 0) {
          const stmts = countStmts(decl.body.list);
          if (stmts > stmtLimit) {
            pass.report({ pos: decl.name!.pos(), message: `Function '${name}' has too many statements (${stmts} > ${stmtLimit})` });
            continue;
          }
        }
        if (lineLimit > 0) {
          const lines = countLines(pass, file, decl);
          if (lines > lineLimit) {
            pass.report({ pos: decl.name!.pos(), message: `Function '${name}' is too long (${lines} > ${lineLimit})` });
          }
        }
      }
    }
  },
});

// countLines counts the lines between a function's first and last, less
// comment lines when ignoring comments.
function countLines(pass: Pass<Config>, file: ast.File, fn: ast.FuncDecl): number {
  const line = (pos: number) => pass.fset.position(pos).line;
  const start = line(fn.pos());
  const end = line(fn.end());
  let count = end - start - 1;
  if (pass.config.ignoreComments) {
    for (const group of file.comments) {
      if (line(group!.pos()) > start && line(group!.end()) < end) {
        count -= group!.list.length;
      }
    }
  }
  return count;
}

function countStmts(stmts: (ast.Stmt | null)[]): number {
  let total = 0;
  for (const stmt of stmts) {
    total++;
    switch (stmt?.$type) {
      case "BlockStmt":
        total += countStmts(stmt.list) - 1;
        break;
      case "ForStmt":
      case "RangeStmt":
      case "IfStmt":
      case "SwitchStmt":
      case "TypeSwitchStmt":
      case "SelectStmt":
        total += countStmts(stmt.body!.list);
        break;
      case "CaseClause":
        total += countStmts(stmt.body);
        break;
      case "AssignStmt":
        total += inlineFunc(stmt.rhs[0]);
        break;
      case "GoStmt":
      case "DeferStmt":
        total += inlineFunc(stmt.call!.fun);
        break;
    }
  }
  return total;
}

function inlineFunc(expr: ast.Expr | null): number {
  return expr?.$type === "FuncLit" ? countStmts(expr.body!.list) : 0;
}
