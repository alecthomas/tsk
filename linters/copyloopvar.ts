import * as ast from "go/ast";
import * as token from "go/token";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Also report copying a loop variable to a variable of another name. */
  checkAlias: boolean;
}

export default defineAnalyzer<Config>({
  name: "copyloopvar",
  doc: `detect places where loop variables are copied

Since Go 1.22 each iteration has its own loop variables, so copies such as
v := v are redundant. Files built for an older Go version are skipped.`,
  requires: [inspect],
  config: { checkAlias: false },
  run(pass) {
    for (const fileCursor of pass.resultOf(inspect).root().children()) {
      if (!perIterationLoopVars(pass.typesInfo.fileVersions.get(fileCursor.node() as ast.File))) {
        continue;
      }
      for (const cursor of fileCursor.preorder(ast.RangeStmt, ast.ForStmt)) {
        const node = cursor.node()!;
        if (node.$type === "RangeStmt") {
          checkRange(pass, node);
        } else if (node.$type === "ForStmt") {
          checkFor(pass, node);
        }
      }
    }
  },
});

// perIterationLoopVars reports whether a file's Go version, such as
// "go1.22", gives each iteration its own variables. Unknown versions do.
function perIterationLoopVars(version: string | undefined): boolean {
  const match = /^go1\.(\d+)/.exec(version ?? "");
  return match === null || Number(match[1]) >= 22;
}

function checkRange(pass: Pass<Config>, stmt: ast.RangeStmt): void {
  if (stmt.key?.$type !== "Ident") {
    return;
  }
  if (stmt.value !== null && stmt.value.$type !== "Ident") {
    return;
  }
  const names = new Set([stmt.key.name]);
  if (stmt.value?.$type === "Ident") {
    names.add(stmt.value.name);
  }
  checkBody(pass, stmt.body!, names);
}

function checkFor(pass: Pass<Config>, stmt: ast.ForStmt): void {
  if (stmt.init?.$type !== "AssignStmt") {
    return;
  }
  const names = new Set<string>();
  for (const lhs of stmt.init.lhs) {
    if (lhs?.$type === "Ident") {
      names.add(lhs.name);
    }
  }
  checkBody(pass, stmt.body!, names);
}

function checkBody(pass: Pass<Config>, body: ast.BlockStmt, names: Set<string>): void {
  for (const stmt of body.list) {
    if (stmt?.$type !== "AssignStmt" || stmt.tok !== token.DEFINE) {
      continue;
    }
    stmt.rhs.forEach((rhs, i) => {
      if (rhs?.$type !== "Ident" || !names.has(rhs.name)) {
        return;
      }
      const lhs = stmt.lhs[i];
      if (!pass.config.checkAlias && (lhs?.$type !== "Ident" || lhs.name !== rhs.name)) {
        return;
      }
      report(pass, stmt, rhs, i);
    });
  }
}

function report(pass: Pass<Config>, stmt: ast.AssignStmt, rhs: ast.Ident, i: number): void {
  const lhs = stmt.lhs[0];
  // Only a copy standing alone, as v := v, can be deleted outright.
  const deletable = i === 0 && stmt.lhs.length === 1 && lhs?.$type === "Ident" && lhs.name === rhs.name;
  pass.report({
    pos: stmt.pos(),
    message: `The copy of the 'for' variable "${rhs.name}" can be deleted (Go 1.22+)`,
    suggestedFixes: deletable ? [{ message: "", textEdits: [{ pos: stmt.pos(), end: stmt.end(), newText: "" }] }] : [],
  });
}
