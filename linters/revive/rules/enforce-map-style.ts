import * as ast from "go/ast";
import { isIdent } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "enforce-map-style";

export interface Options {
  /** How to create empty maps: "make", "literal", or "any" style. */
  style: "any" | "make" | "literal";
}

export const defaults: Options = { style: "any" };

export function create(options: DeepReadonly<Options>): Rule {
  return {
    name,
    apply(file: File): Failure[] {
      if (options.style === "any") {
        return [];
      }
      const failures: Failure[] = [];
      ast.inspect(file.ast, (node) => {
        if (node?.$type === "CompositeLit" && options.style === "make") {
          const lit = node as ast.CompositeLit;
          if (isMapType(lit.type) && lit.elts.length === 0) {
            failures.push({ failure: "use make(map[type]type) instead of map[type]type{}", node: lit, confidence: 1 });
          }
        } else if (node?.$type === "CallExpr" && options.style === "literal") {
          const call = node as ast.CallExpr;
          // make(map[type]type, size) is allowed.
          if (isIdent(call.fun, "make") && call.args.length === 1 && isMapType(call.args[0])) {
            failures.push({ failure: "use map[type]type{} instead of make(map[type]type)", node: call.args[0]!, confidence: 1 });
          }
        }
        return true;
      });
      return failures;
    },
  };
}

function isMapType(v: ast.Expr | null): boolean {
  if (v?.$type === "MapType") {
    return true;
  }
  if (v?.$type !== "Ident") {
    return false;
  }
  const decl = (v as ast.Ident).obj?.decl as ast.Node | null | undefined;
  return decl?.$type === "TypeSpec" && isMapType((decl as ast.TypeSpec).type);
}
