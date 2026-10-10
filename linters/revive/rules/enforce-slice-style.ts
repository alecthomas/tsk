import type * as ast from "go/ast";
import { isIdent, type Visitor, walk } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "enforce-slice-style";

export interface Options {
  /** How to create empty slices: "make", "literal", "nil", or "any" style. */
  style: "any" | "make" | "literal" | "nil";
}

export const defaults: Options = { style: "any" };

export function create(options: DeepReadonly<Options>): Rule {
  const style = options.style;
  return {
    name,
    apply(file: File): Failure[] {
      if (style === "any") {
        return [];
      }
      const failures: Failure[] = [];
      const stack: ast.Node[] = [];
      const visitor: Visitor = {
        visit(node) {
          if (node === null) {
            stack.pop();
            return null;
          }
          const parent = stack[stack.length - 1];
          stack.push(node);
          if (node.$type === "CompositeLit" && (style === "make" || style === "nil")) {
            const lit = node as ast.CompositeLit;
            if (isSliceType(lit.type) && lit.elts.length === 0) {
              const failure = style === "nil" ? nilSliceFailureMessage(parent, "[]type{}") : "use make([]type) instead of []type{} (or declare nil slice)";
              failures.push({ failure, node: lit, confidence: 1 });
            }
          } else if (node.$type === "CallExpr" && (style === "literal" || style === "nil")) {
            const call = node as ast.CallExpr;
            if (isEmptyMake(call)) {
              const failure =
                style === "nil" ? nilSliceFailureMessage(parent, "make([]type, 0)") : "use []type{} instead of make([]type, 0) (or declare nil slice)";
              failures.push({ failure, node: call.args[0]!, confidence: 1 });
            }
          }
          return visitor;
        },
      };
      walk(visitor, file.ast);
      return failures;
    },
  };
}

// isEmptyMake reports whether call is make of a slice type with literal zero
// length and, if given, literal zero capacity.
function isEmptyMake(call: ast.CallExpr): boolean {
  if (!isIdent(call.fun, "make") || call.args.length < 2 || !isSliceType(call.args[0])) {
    return false;
  }
  return call.args.slice(1, 3).every((arg) => arg!.$type === "BasicLit" && (arg as ast.BasicLit).value === "0");
}

function nilSliceFailureMessage(parent: ast.Node | undefined, instead: string): string {
  if (parent?.$type === "ValueSpec") {
    return `use nil slice declaration (e.g. var args []type) instead of ${instead}`;
  }
  return `use nil slice (e.g. []type(nil)) instead of ${instead}`;
}

function isSliceType(v: ast.Expr | null): boolean {
  if (v?.$type === "ArrayType") {
    return (v as ast.ArrayType).len === null;
  }
  if (v?.$type !== "Ident") {
    return false;
  }
  const decl = (v as ast.Ident).obj?.decl as ast.Node | null | undefined;
  return decl?.$type === "TypeSpec" && isSliceType((decl as ast.TypeSpec).type);
}
