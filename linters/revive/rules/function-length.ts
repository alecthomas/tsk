import type * as ast from "go/ast";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "function-length";

export interface Options {
  /** The most statements a function may have, or 0 for no limit. */
  maxStatements: number;
  /** The most lines a function body may have, or 0 for no limit. */
  maxLines: number;
}

export const defaults: Options = { maxStatements: 50, maxLines: 75 };

export function create(options: DeepReadonly<Options>): Rule {
  if (options.maxStatements < 0) {
    throw new Error(`the configuration value for max statements in "function-length" rule cannot be negative, got ${options.maxStatements}`);
  }
  if (options.maxLines < 0) {
    throw new Error(`the configuration value for max statements in "function-length" rule cannot be negative, got ${options.maxLines}`);
  }
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      for (const decl of file.ast.decls) {
        if (decl!.$type !== "FuncDecl") {
          continue;
        }
        const fn = decl as ast.FuncDecl;
        const body = fn.body;
        // Revive stops checking the file at the first empty function, which
        // looks like a bug, so this skips only that function.
        if (body === null || body.list.length === 0) {
          continue;
        }
        if (options.maxStatements > 0) {
          const count = countStmts(body.list);
          if (count > options.maxStatements) {
            failures.push({ failure: `maximum number of statements per function exceeded; max ${options.maxStatements} but got ${count}`, node: fn, confidence: 1 });
          }
        }
        if (options.maxLines > 0) {
          const count = file.toPosition(body.end()).line - file.toPosition(body.pos()).line - 1;
          if (count > options.maxLines) {
            failures.push({ failure: `maximum number of lines per function exceeded; max ${options.maxLines} but got ${count}`, node: fn, confidence: 1 });
          }
        }
      }
      return failures;
    },
  };
}

function countStmts(list: readonly (ast.Stmt | null)[]): number {
  let count = 0;
  for (const s of list) {
    switch (s!.$type) {
      case "BlockStmt":
        count += countStmts((s as ast.BlockStmt).list);
        break;
      case "IfStmt": {
        const stmt = s as ast.IfStmt;
        count += 1 + countStmts(stmt.body!.list);
        if (stmt.else !== null && stmt.else.$type === "BlockStmt") {
          count += countStmts((stmt.else as ast.BlockStmt).list);
        }
        break;
      }
      case "ForStmt":
      case "RangeStmt":
      case "SwitchStmt":
      case "TypeSwitchStmt":
      case "SelectStmt":
        count += 1 + countStmts((s as ast.ForStmt | ast.RangeStmt | ast.SwitchStmt | ast.TypeSwitchStmt | ast.SelectStmt).body!.list);
        break;
      case "CaseClause":
        count += countStmts((s as ast.CaseClause).body);
        break;
      case "AssignStmt":
        count += 1 + countFuncLitStmts((s as ast.AssignStmt).rhs[0]!);
        break;
      case "GoStmt":
        count += 1 + countFuncLitStmts((s as ast.GoStmt).call!.fun!);
        break;
      case "DeferStmt":
        count += 1 + countFuncLitStmts((s as ast.DeferStmt).call!.fun!);
        break;
      default:
        count++;
    }
  }
  return count;
}

function countFuncLitStmts(expr: ast.Expr): number {
  return expr.$type === "FuncLit" ? countStmts((expr as ast.FuncLit).body!.list) : 0;
}
