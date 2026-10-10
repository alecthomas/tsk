import * as ast from "go/ast";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "comments-density";

export interface Options {
  /** The lowest percentage of comment lines to comment and code lines allowed. */
  minimum: number;
}

export const defaults: Options = { minimum: 0 };

const statements = new Set([
  "ExprStmt",
  "AssignStmt",
  "ReturnStmt",
  "GoStmt",
  "DeferStmt",
  "BranchStmt",
  "IfStmt",
  "SwitchStmt",
  "TypeSwitchStmt",
  "SelectStmt",
  "ForStmt",
  "RangeStmt",
  "CaseClause",
  "CommClause",
  "DeclStmt",
  "FuncDecl",
]);

export function create(options: DeepReadonly<Options>): Rule {
  if (!Number.isInteger(options.minimum)) {
    throw new Error(`invalid argument for "comments-density" rule: argument should be an int, got float64`);
  }
  return {
    name,
    apply(file: File): Failure[] {
      const comments = file.ast.comments.reduce((acc, group) => acc + group!.text().split("\n").length - 1, 0);
      let code = 0;
      ast.inspect(file.ast, (n) => {
        if (n !== null && statements.has(n.$type)) {
          code++;
        }
        return true;
      });
      const density = (comments / (code + comments)) * 100;
      if (!(density < options.minimum)) {
        return [];
      }
      const percent = String(roundHalfEven(density)).padStart(2);
      return [
        {
          failure: `the file has a comment density of ${percent}% (${comments} comment lines for ${code} code lines) but expected a minimum of ${options.minimum}%`,
          node: file.ast,
          confidence: 1,
        },
      ];
    },
  };
}

// roundHalfEven rounds as Go's %.0f does.
function roundHalfEven(n: number): number {
  const rounded = Math.round(n);
  return rounded - n === 0.5 && rounded % 2 !== 0 ? rounded - 1 : rounded;
}
