import * as ast from "go/ast";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

export default defineAnalyzer({
  name: "forcetypeassert",
  doc: `finds forced type assertions

An unchecked type assertion panics when the value has another type. Assigning
its second result, as in v, ok := x.(T), checks it.`,
  requires: [inspect],
  run(pass: Pass<unknown>) {
    const anyType = types.Universe!.lookup("any")!.type();
    const isAny = (expr: ast.Expr): boolean => types.identical(pass.typesInfo.typeOf(expr), anyType);
    // Returning false skips a node's children, so an assertion an assignment
    // or declaration reports is not reported again on its own.
    pass
      .resultOf(inspect)
      .root()
      .inspect([ast.AssignStmt, ast.ValueSpec, ast.TypeAssertExpr], (cursor) => {
        const node = cursor.node()!;
        switch (node.$type) {
          case "AssignStmt":
            return checkAssignment(pass, isAny, node, node.lhs.length, node.rhs);
          case "ValueSpec":
            return checkAssignment(pass, isAny, node, node.names.length, node.values);
          case "TypeAssertExpr":
            if (node.type !== null && !isAny(node.type)) {
              pass.report({ pos: node.pos(), message: "type assertion must be checked" });
            }
            return false;
        }
        return true;
      });
  },
});

// checkAssignment checks an assignment or declaration of values to targets,
// and reports whether to visit its children.
function checkAssignment(
  pass: Pass<unknown>,
  isAny: (expr: ast.Expr) => boolean,
  node: ast.Node,
  targets: number,
  values: readonly (ast.Expr | null)[],
): boolean {
  const assertion = findTypeAssertion(values);
  if (assertion === null) {
    return true;
  }
  // A call's result, or one of several values, cannot also yield the
  // assertion's ok result.
  if ((values.length === 1 && values[0]?.$type === "CallExpr") || values.length > 1) {
    pass.report({ pos: node.pos(), message: "right hand must be only type assertion" });
    return false;
  }
  if (targets !== 2 && assertion.type !== null && !isAny(assertion.type)) {
    pass.report({ pos: node.pos(), message: "type assertion must be checked" });
    return false;
  }
  return targets !== 2;
}

// findTypeAssertion returns the last type assertion, outside function
// literals, in the first value holding one, as upstream finds it.
function findTypeAssertion(values: readonly (ast.Expr | null)[]): ast.TypeAssertExpr | null {
  for (const value of values) {
    let found: ast.TypeAssertExpr | null = null;
    ast.inspect(value, (node) => {
      if (node?.$type === "FuncLit") {
        return false;
      }
      if (node?.$type === "TypeAssertExpr") {
        found = node;
        return false;
      }
      return true;
    });
    if (found !== null) {
      return found;
    }
  }
  return null;
}
