import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, formatNode, type Pass } from "tsk";
import { inspect } from "tsk/passes";

export default defineAnalyzer({
  name: "noinlineerr",
  doc: "Disallows inline error handling (`if err := ...; err != nil {`)",
  requires: [inspect],
  run(pass: Pass<unknown>) {
    const errorType = types.Universe!.lookup("error")!.type();
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.IfStmt)) {
      const ifStmt = cursor.node() as ast.IfStmt;
      const assign = ifStmt.init;
      if (assign?.$type !== "AssignStmt") {
        continue;
      }
      const message =
        assign.tok === token.ASSIGN
          ? "avoid inline error handling using `if err = ...; err != nil`; use plain assignment `err = ...`"
          : "avoid inline error handling using `if err := ...; err != nil`; use plain assignment `err := ...`";
      for (const lhs of assign.lhs) {
        if (lhs?.$type !== "Ident") {
          continue;
        }
        const obj = pass.typesInfo.objectOf(lhs);
        if (obj === null || !types.assignableTo(obj.type(), errorType) || lhs.name === "_" || !usedIn(ifStmt.cond, lhs.name)) {
          continue;
        }
        // Moving the assignment out could clash with other variables, so
        // only a single new name without one of the same name above gets a fix.
        if (assign.lhs.length !== 1 || (assign.tok === token.DEFINE && shadows(pass, ifStmt, lhs.name))) {
          pass.report({ pos: lhs.pos(), message });
          break;
        }
        pass.report({
          pos: lhs.pos(),
          end: lhs.end(),
          message,
          suggestedFixes: [
            {
              message: "move err assignment outside if",
              textEdits: [
                { pos: ifStmt.pos(), end: ifStmt.pos(), newText: `${formatNode(assign, pass.fset)}\n` },
                // The assignment's semicolon goes with it.
                { pos: assign.pos(), end: assign.end() + 1, newText: "" },
              ],
            },
          ],
        });
      }
    }
  },
});

function shadows(pass: Pass<unknown>, ifStmt: ast.IfStmt, name: string): boolean {
  const parent = pass.typesInfo.scopes.get(ifStmt)?.parent();
  return parent !== null && parent !== undefined && parent.lookup(name) !== null;
}

function usedIn(cond: ast.Expr | null, name: string): boolean {
  let used = false;
  ast.inspect(cond, (node) => {
    if (node?.$type === "Ident" && node.name === name) {
      used = true;
      return false;
    }
    return true;
  });
  return used;
}
