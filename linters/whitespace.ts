import * as ast from "go/ast";
import type * as token from "go/token";
import { defineAnalyzer, type Pass } from "tsk";

interface Config {
  /** Check that multi-line if statements have a leading newline. */
  multiIf: boolean;
  /** Check that multi-line function signatures have a leading newline. */
  multiFunc: boolean;
}

export default defineAnalyzer<Config>({
  name: "whitespace",
  doc: "Whitespace is a linter that checks for unnecessary newlines at the start and end of functions, if, for, etc.",
  // Only syntax is needed, so packages with type errors are checked too.
  runDespiteErrors: true,
  config: { multiIf: false, multiFunc: false },
  run(pass) {
    for (const file of pass.files) {
      if (!pass.fset.position(file!.pos()).filename.endsWith(".go")) {
        continue;
      }
      for (const decl of file!.decls) {
        // The body is nil for functions implemented elsewhere.
        if (decl?.$type === "FuncDecl" && decl.body !== null) {
          checkDecl(pass, file!.comments as ast.CommentGroup[], decl);
        }
      }
    }
  },
});

function checkDecl(pass: Pass<Config>, comments: ast.CommentGroup[], decl: ast.FuncDecl): void {
  const line = (pos: token.Pos) => pass.fset.position(pos).line;
  const wantNewline = new Set<ast.BlockStmt>();
  // Bodies of multi-line headers are marked before the walk reaches them.
  const checkMultiLine = (body: ast.BlockStmt | null, start: ast.Node) => {
    if (body !== null && line(start.end()) > line(start.pos())) {
      wantNewline.add(body);
    }
  };
  ast.inspect(decl, (node) => {
    if (node?.$type === "IfStmt" && pass.config.multiIf) {
      checkMultiLine(node.body, node.cond!);
    } else if ((node?.$type === "FuncLit" || node?.$type === "FuncDecl") && pass.config.multiFunc) {
      checkMultiLine(node.body, node.type!);
    } else if (node?.$type === "BlockStmt") {
      checkBlock(pass, node, wantNewline.has(node) ? [] : comments, wantNewline.has(node));
    }
    return true;
  });
}

function checkBlock(pass: Pass<Config>, stmt: ast.BlockStmt, comments: ast.CommentGroup[], wantNewline: boolean): void {
  const line = (pos: token.Pos) => pass.fset.position(pos).line;
  const { opening, first, last } = firstAndLast(pass, comments, stmt);
  const leading = first !== null && line(opening) + 1 < line(first.pos());
  if (wantNewline && !leading && stmt.list.length >= 1) {
    const pos = stmt.list[0]!.pos();
    pass.report({
      pos: opening,
      message: "multi-line statement should be followed by a newline",
      suggestedFixes: [{ message: "", textEdits: [{ pos, end: pos, newText: "\n" }] }],
    });
  } else if (!wantNewline && leading) {
    pass.report({
      pos: opening,
      message: "unnecessary leading newline",
      suggestedFixes: [{ message: "", textEdits: [{ pos: opening, end: first!.pos(), newText: "\n" }] }],
    });
  }
  if (last !== null && line(stmt.rbrace) - 1 > line(last.end())) {
    pass.report({
      pos: stmt.rbrace,
      message: "unnecessary trailing newline",
      suggestedFixes: [{ message: "", textEdits: [{ pos: last.end(), end: stmt.rbrace, newText: "\n" }] }],
    });
  }
}

// firstAndLast returns where a block's content may start, and its first and
// last statements or comments.
function firstAndLast(
  pass: Pass<Config>,
  comments: ast.CommentGroup[],
  stmt: ast.BlockStmt,
): { opening: token.Pos; first: ast.Node | null; last: ast.Node | null } {
  const line = (pos: token.Pos) => pass.fset.position(pos).line;
  let opening = stmt.lbrace + 1;
  if (stmt.list.length === 0) {
    return { opening, first: null, last: null };
  }
  let first: ast.Node = stmt.list[0]!;
  let last: ast.Node = stmt.list[stmt.list.length - 1]!;
  for (const c of comments) {
    // A comment after the brace moves the start past it, unless it continues
    // onto later lines.
    if (line(c.pos()) === line(opening) && c.pos() > opening) {
      if (line(c.end()) !== line(opening)) {
        first = c;
      } else {
        opening = c.end();
      }
    }
    if (line(c.pos()) === line(stmt.pos()) || line(c.end()) === line(stmt.end())) {
      continue;
    }
    if (c.pos() < stmt.pos() || c.end() > stmt.end()) {
      continue;
    }
    if (c.pos() < first.pos()) {
      first = c;
    }
    if (c.end() > last.end()) {
      last = c;
    }
  }
  return { opening, first, last };
}
