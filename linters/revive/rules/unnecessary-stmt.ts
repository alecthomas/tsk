import * as ast from "go/ast";
import * as token from "go/token";
import type { Failure, File, Rule } from "../lint";

export const name = "unnecessary-stmt";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  const fail = (node: ast.Node, failure: string): void => {
    failures.push({ failure, node, confidence: 1 });
  };
  const checkSwitchBody = (body: ast.BlockStmt): void => {
    if (body.list.length !== 1 || body.list[0]!.$type !== "CaseClause") {
      return;
    }
    if ((body.list[0] as ast.CaseClause).list.length > 1) {
      return;
    }
    fail(body, "switch with only one case can be replaced by an if-then");
  };
  ast.inspect(file.ast, (node) => {
    switch (node?.$type) {
      case "FuncDecl": {
        const fn = node as ast.FuncDecl;
        if (fn.body === null || fn.type!.results !== null) {
          break;
        }
        const last = fn.body.list[fn.body.list.length - 1];
        if (last?.$type === "ReturnStmt" && (last as ast.ReturnStmt).results.length === 0) {
          fail(last, "omit unnecessary return statement");
        }
        break;
      }
      case "SwitchStmt":
        checkSwitchBody((node as ast.SwitchStmt).body!);
        break;
      case "TypeSwitchStmt":
        checkSwitchBody((node as ast.TypeSwitchStmt).body!);
        break;
      case "CaseClause": {
        const body = (node as ast.CaseClause).body;
        const last = body[body.length - 1];
        if (last?.$type === "BranchStmt" && (last as ast.BranchStmt).tok === token.BREAK && (last as ast.BranchStmt).label === null) {
          fail(last, "omit unnecessary break at the end of case clause");
        }
        break;
      }
    }
    return true;
  });
  return failures;
}
