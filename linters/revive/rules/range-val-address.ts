import type * as ast from "go/ast";
import * as token from "go/token";
import { walk, type Visitor } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "range-val-address";

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
      if (node === null || node.$type !== "RangeStmt" || node.value === null || node.value.$type !== "Ident") {
        return visitor;
      }
      const value = node.value;
      const valueIsStarExpr = file.pkg.typeOf(value)?.string().startsWith("*") ?? false;
      walk(bodyVisitor(value, valueIsStarExpr, failures), node.body!);
      return visitor;
    },
  };
  walk(visitor, file.ast);
  return failures;
}

function bodyVisitor(value: ast.Ident, valueIsStarExpr: boolean, failures: Failure[]): Visitor {
  const isAccessingValueAddress = (exp: ast.Expr | null): boolean => {
    if (exp === null || exp.$type !== "UnaryExpr" || exp.op !== token.AND) {
      return false;
    }
    let v = exp.x!;
    if (v.$type === "SelectorExpr") {
      // A field of a pointer value has its own address.
      if (valueIsStarExpr) {
        return false;
      }
      v = v.x!;
    }
    return v.$type === "Ident" && v.obj === value.obj;
  };
  const report = (node: ast.Node) => {
    failures.push({ failure: `suspicious assignment of '${value.name}'. range-loop variables always have the same address`, node, confidence: 1 });
  };
  const checkCompositeLit = (lit: ast.CompositeLit) => {
    for (const elt of lit.elts) {
      if (elt!.$type === "KeyValueExpr" && isAccessingValueAddress(elt.value)) {
        report(elt.value!);
      }
    }
  };
  const visitor: Visitor = {
    visit(node) {
      if (node === null || node.$type !== "AssignStmt") {
        return visitor;
      }
      for (const exp of node.lhs) {
        if (exp!.$type === "IndexExpr" && isAccessingValueAddress(exp.index)) {
          report(exp.index!);
        }
      }
      for (const exp of node.rhs) {
        switch (exp!.$type) {
          case "UnaryExpr":
            if (isAccessingValueAddress(exp)) {
              report(exp);
            }
            break;
          case "CallExpr":
            if (exp.fun!.$type === "Ident" && exp.fun.name === "append") {
              for (const arg of exp.args) {
                if (arg!.$type === "CompositeLit") {
                  checkCompositeLit(arg);
                } else if (isAccessingValueAddress(arg)) {
                  report(arg!);
                }
              }
            }
            break;
          case "CompositeLit":
            checkCompositeLit(exp);
            break;
        }
      }
      return visitor;
    },
  };
  return visitor;
}
