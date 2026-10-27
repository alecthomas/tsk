// Port of golang.org/x/tools/go/analysis/passes/assign at v0.50.0.
import * as ast from "go/ast";
import * as token from "go/token";
import type * as types from "go/types";
import { defineAnalyzer, formatNode, type SuggestedFix, type TextEdit } from "tsk";
import { inspect } from "tsk/passes";
import { noEffects } from "./internal/typesinternal";

export default defineAnalyzer({
  name: "assign",
  doc: `check for useless assignments

This checker reports assignments of the form x = x or a[i] = a[i].
These are almost always useless, and even when they aren't they are
usually a mistake.`,
  group: "govet",
  requires: [inspect],
  run(pass) {
    const info = pass.typesInfo;
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.AssignStmt)) {
      const stmt = cursor.node() as ast.AssignStmt;
      if (stmt.tok !== token.ASSIGN || stmt.lhs.length !== stmt.rhs.length) {
        continue;
      }
      // Delete redundant LHS, RHS pairs, including intervening commas.
      const exprs: string[] = [];
      const edits: TextEdit[] = [];
      // Valid only within a run of self-assignments.
      let runStartLHS = token.NoPos;
      let runStartRHS = token.NoPos;
      for (let i = 0; i < stmt.lhs.length; i++) {
        const lhs = stmt.lhs[i]!;
        const rhs = stmt.rhs[i]!;
        let isSelfAssign = false;
        let le = "";
        if (noEffects(info, lhs) && noEffects(info, rhs) && !isMapIndex(info, lhs) && lhs.$type === rhs.$type) {
          le = formatNode(lhs, pass.fset);
          isSelfAssign = le === formatNode(rhs, pass.fset);
        }
        if (isSelfAssign) {
          exprs.push(le);
          if (runStartLHS === token.NoPos) {
            if (i > 0) {
              runStartLHS = stmt.lhs[i - 1]!.end();
              runStartRHS = stmt.rhs[i - 1]!.end();
            } else {
              runStartLHS = lhs.pos();
              runStartRHS = rhs.pos();
            }
          }
        } else if (runStartLHS !== token.NoPos) {
          let endLHS = stmt.lhs[i - 1]!.end();
          let endRHS = stmt.rhs[i - 1]!.end();
          if (runStartLHS === stmt.lhs[0]!.pos()) {
            endLHS = lhs.pos();
            endRHS = rhs.pos();
          }
          edits.push({ pos: runStartLHS, end: endLHS, newText: "" }, { pos: runStartRHS, end: endRHS, newText: "" });
          runStartLHS = token.NoPos;
          runStartRHS = token.NoPos;
        }
      }
      if (runStartLHS !== token.NoPos) {
        const last = stmt.lhs.length - 1;
        edits.push({ pos: runStartLHS, end: stmt.lhs[last]!.end(), newText: "" }, { pos: runStartRHS, end: stmt.rhs[last]!.end(), newText: "" });
      }
      if (exprs.length === 0) {
        continue;
      }
      // Upstream deletes a statement that only self-assigns with refactor.DeleteStmt,
      // which is too large to port, so that case has no fix.
      const fixes: SuggestedFix[] = exprs.length === stmt.lhs.length ? [] : [{ message: "Remove self-assignment", textEdits: edits }];
      pass.report({ pos: stmt.pos(), message: `self-assignment of ${exprs.join(", ")}`, suggestedFixes: fixes });
    }
  },
});

function isMapIndex(info: types.Info, e: ast.Expr): boolean {
  const idx = ast.unparen(e);
  if (idx?.$type === "IndexExpr") {
    const typ = info.types.get(idx.x!)?.type ?? null;
    if (typ !== null) {
      return typ.underlying()?.$type === "Map";
    }
  }
  return false;
}
