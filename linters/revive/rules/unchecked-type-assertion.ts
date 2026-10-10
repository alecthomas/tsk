import type * as ast from "go/ast";
import { goFmt, isIdent, walk, type Visitor } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "unchecked-type-assertion";

export interface Options {
  /** Whether to allow assertions whose ok result is assigned to _. */
  acceptIgnoredAssertionResult: boolean;
}

export const defaults: Options = { acceptIgnoredAssertionResult: false };

const messagePanic = "type assertion will panic if not matched";
const messageIgnored = "type assertion result ignored";

export function create(options: DeepReadonly<Options>): Rule {
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      const addFailure = (n: ast.TypeAssertExpr, why: string) => {
        failures.push({ failure: `type cast result is unchecked in ${goFmt(n)} - ${why}`, node: n, confidence: 1 });
      };
      // A type switch's x.(type) has no type.
      const requireNoTypeAssert = (expr: ast.Expr | null) => {
        if (expr !== null && expr.$type === "TypeAssertExpr" && expr.type !== null) {
          addFailure(expr, messagePanic);
        }
      };
      const requireBinaryWithoutTypeAssert = (expr: ast.Expr | null) => {
        if (expr !== null && expr.$type === "BinaryExpr") {
          requireNoTypeAssert(expr.x);
          requireNoTypeAssert(expr.y);
        }
      };
      const visitor: Visitor = {
        visit(n) {
          if (n === null) {
            return visitor;
          }
          switch (n.$type) {
            case "RangeStmt":
              requireNoTypeAssert(n.x);
              break;
            case "SwitchStmt":
              requireNoTypeAssert(n.tag);
              requireBinaryWithoutTypeAssert(n.tag);
              break;
            case "ReturnStmt":
              // Go does not forward a type assertion's results from a return.
              n.results.forEach(requireNoTypeAssert);
              break;
            case "AssignStmt": {
              const e = n.rhs[0];
              if (e === undefined || e === null || e.$type !== "TypeAssertExpr" || e.type === null) {
                break;
              }
              if (n.lhs.length === 1) {
                addFailure(e, messagePanic);
              }
              if (!options.acceptIgnoredAssertionResult && n.lhs.length === 2 && isIdent(n.lhs[1], "_")) {
                addFailure(e, messageIgnored);
              }
              break;
            }
            case "IfStmt":
              requireBinaryWithoutTypeAssert(n.cond);
              break;
            case "CaseClause":
              for (const expr of n.list) {
                requireNoTypeAssert(expr);
                requireBinaryWithoutTypeAssert(expr);
              }
              break;
            case "SendStmt":
              requireNoTypeAssert(n.value);
              break;
          }
          return visitor;
        },
      };
      walk(visitor, file.ast);
      return failures;
    },
  };
}
