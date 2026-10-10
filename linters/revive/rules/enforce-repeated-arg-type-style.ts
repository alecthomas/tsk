import * as ast from "go/ast";
import { goFmt } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "enforce-repeated-arg-type-style";

type Style = "any" | "short" | "full";

// Revive also takes one string for both styles; here each is set separately.
export interface Options {
  /** How to write repeated argument types: "short", "full", or "any" style. */
  funcArgStyle: Style;
  /** How to write repeated return types: "short", "full", or "any" style. */
  funcRetValStyle: Style;
}

export const defaults: Options = { funcArgStyle: "any", funcRetValStyle: "any" };

export function create(options: DeepReadonly<Options>): Rule {
  return {
    name,
    apply(file: File): Failure[] {
      if (options.funcArgStyle === "any" && options.funcRetValStyle === "any") {
        return [];
      }
      const failures: Failure[] = [];
      ast.inspect(file.ast, (node) => {
        if (node?.$type !== "FuncDecl") {
          return true;
        }
        const fnType = (node as ast.FuncDecl).type!;
        check(fnType.params, options.funcArgStyle, "argument", false, failures);
        check(fnType.results, options.funcRetValStyle, "return", true, failures);
        return true;
      });
      return failures;
    },
  };
}

// check reports fields that break style. Upstream only reports a repeated
// return type whose field has names, but any repeated argument type.
function check(fields: ast.FieldList | null, style: Style, kind: string, needNames: boolean, failures: Failure[]): void {
  if (fields === null) {
    return;
  }
  if (style === "full") {
    for (const field of fields.list) {
      if (field!.names.length > 1) {
        failures.push({ failure: `${kind} types should not be omitted`, node: field!, confidence: 1 });
      }
    }
  } else if (style === "short") {
    let prevType: ast.Expr | null = null;
    for (const field of fields.list) {
      const prevTypeStr = prevType === null ? "" : goFmt(prevType);
      if ((!needNames || field!.names.length > 0) && goFmt(field!.type!) === prevTypeStr) {
        failures.push({ failure: `repeated ${kind} type ${JSON.stringify(prevTypeStr)} can be omitted`, node: prevType!, confidence: 1 });
      }
      prevType = field!.type;
    }
  }
}
