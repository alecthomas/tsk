import * as ast from "go/ast";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Report naked returns in functions longer than this many lines. */
  maxFuncLines: number;
}

export default defineAnalyzer<Config>({
  name: "nakedret",
  doc: "Checks that functions with naked returns are not longer than a maximum size (can be zero).",
  requires: [inspect],
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  config: { maxFuncLines: 30 },
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.ReturnStmt)) {
      const stmt = cursor.node() as ast.ReturnStmt;
      if (stmt.results.length > 0) {
        continue;
      }
      const funcs = cursor
        .enclosing(ast.FuncDecl, ast.FuncLit)
        .toArray()
        .map((c) => c.node() as ast.FuncDecl | ast.FuncLit);
      if (funcs.length > 0) {
        check(pass, stmt, funcs);
      }
    }
  },
});

// check reports a naked return in the innermost of funcs, which run from
// innermost to outermost, if that function is too long and names its results.
function check(pass: Pass<Config>, stmt: ast.ReturnStmt, funcs: (ast.FuncDecl | ast.FuncLit)[]): void {
  const fn = funcs[0];
  const start = pass.fset.position(fn.pos()).line;
  // A function on one line counts as one line, not zero.
  const length = Math.max(pass.fset.position(fn.end()).line - start, 1);
  const names = resultNames(fn.type!);
  if (length <= pass.config.maxFuncLines || names.length === 0) {
    return;
  }
  const funcName = funcs
    .map((f) => (f.$type === "FuncDecl" ? f.name!.name : `<func():${pass.fset.position(f.pos()).line}>`))
    .reverse()
    .join(".");
  pass.report({
    pos: stmt.pos(),
    end: stmt.end(),
    message: `naked return in func \`${funcName}\` with ${length} lines of code`,
    suggestedFixes: [
      {
        message: "explicit return statement",
        textEdits: [{ pos: stmt.pos(), end: stmt.end(), newText: `return ${names.join(", ")}` }],
      },
    ],
  });
}

function resultNames(type: ast.FuncType): string[] {
  return (type.results?.list ?? []).flatMap((field) => field!.names.map((name) => name!.name));
}
