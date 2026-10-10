import * as ast from "go/ast";
import * as token from "go/token";
import { funcName } from "../funcname";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "cyclomatic";

export interface Options {
  /** The highest cyclomatic complexity a function may have. */
  max: number;
}

export const defaults: Options = { max: 10 };

export function create(options: DeepReadonly<Options>): Rule {
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      for (const decl of file.ast.decls) {
        if (decl!.$type !== "FuncDecl") {
          continue;
        }
        const fn = decl as ast.FuncDecl;
        const c = complexity(fn);
        if (c > options.max) {
          failures.push({ failure: `function ${funcName(fn)} has cyclomatic complexity ${c} (> max enabled ${options.max})`, node: fn, confidence: 1 });
        }
      }
      return failures;
    },
  };
}

function complexity(fn: ast.FuncDecl): number {
  let c = 0;
  ast.inspect(fn, (n) => {
    switch (n?.$type) {
      case "FuncDecl":
      case "IfStmt":
      case "ForStmt":
      case "RangeStmt":
      case "CaseClause":
      case "CommClause":
        c++;
        break;
      case "BinaryExpr": {
        const op = (n as ast.BinaryExpr).op;
        if (op === token.LAND || op === token.LOR) {
          c++;
        }
        break;
      }
    }
    return true;
  });
  return c;
}
