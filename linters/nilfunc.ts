// Port of golang.org/x/tools/go/analysis/passes/nilfunc at v0.50.0.
import * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";
import { usedIdent } from "./internal/typesinternal";

export default defineAnalyzer({
  name: "nilfunc",
  doc: `check for useless comparisons between functions and nil

A useless comparison is one like f == nil as opposed to f() == nil.`,
  group: "govet",
  requires: [inspect],
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.BinaryExpr)) {
      const e = cursor.node() as ast.BinaryExpr;
      if (e.op !== token.EQL && e.op !== token.NEQ) {
        continue;
      }
      let e2: ast.Expr;
      if (pass.typesInfo.types.get(e.x!)?.isNil()) {
        e2 = e.y!;
      } else if (pass.typesInfo.types.get(e.y!)?.isNil()) {
        e2 = e.x!;
      } else {
        continue;
      }
      const id = usedIdent(pass.typesInfo, e2);
      const obj = id === null ? undefined : pass.typesInfo.uses.get(id);
      if (obj?.$type !== "Func") {
        continue;
      }
      pass.report({
        pos: e.pos(),
        end: e.end(),
        message: `comparison of function ${obj.name()} ${token.Token.string(e.op)} nil is always ${e.op === token.NEQ}`,
      });
    }
  },
});
