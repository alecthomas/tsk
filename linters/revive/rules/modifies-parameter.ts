import type * as ast from "go/ast";
import { goFmt, walk, type Visitor } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "modifies-parameter";

// Functions and the positions of the parameters they modify.
const modifyingFunctions = new Map<string, number[]>([
  ["slices.Delete", [0]],
  ["slices.DeleteFunc", [0]],
]);

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  // As in revive, the parameters of the last function declaration seen, so
  // they also apply to declarations after it until the next function.
  let params = new Set<string>();
  // Confidence is low because of shadowing variables.
  const checkParam = (id: ast.Ident) => {
    if (params.has(id.name)) {
      failures.push({ failure: `parameter '${id.name}' seems to be modified`, node: id, confidence: 0.5 });
    }
  };
  const checkModifyingFunction = (node: ast.Expr | null) => {
    if (node === null || node.$type !== "CallExpr") {
      return;
    }
    const funcName = goFmt(node.fun!);
    const positions = modifyingFunctions.get(funcName);
    if (positions === undefined) {
      return;
    }
    for (const pos of positions) {
      if (pos >= node.args.length) {
        return;
      }
      const arg = node.args[pos]!;
      if (arg.$type === "Ident" && params.has(arg.name)) {
        failures.push({ failure: `parameter '${arg.name}' seems to be modified by '${funcName}'`, node, confidence: 0.5 });
      }
    }
  };
  const visitor: Visitor = {
    visit(node) {
      if (node === null) {
        return visitor;
      }
      switch (node.$type) {
        case "FuncDecl":
          params = new Set(
            node.type!.params!.list.flatMap((field) => field!.names.map((n) => n!.name)).filter((n) => n !== "_"),
          );
          break;
        case "IncDecStmt":
          if (node.x!.$type === "Ident") {
            checkParam(node.x);
          }
          break;
        case "AssignStmt":
          node.lhs.forEach((e, i) => {
            if (e!.$type !== "Ident") {
              return;
            }
            if (i < node.rhs.length) {
              checkModifyingFunction(node.rhs[i]);
            }
            checkParam(e);
          });
          break;
        case "ExprStmt":
          checkModifyingFunction(node.x);
          break;
      }
      return visitor;
    },
  };
  walk(visitor, file.ast);
  return failures;
}
