import * as ast from "go/ast";
import * as token from "go/token";
import type * as types from "go/types";
import type * as inspector from "golang.org/x/tools/go/ast/inspector";
import { defineAnalyzer, formatNode, type Pass } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** Report contexts reassigned through struct pointers, which may grow them. */
  checkStructPointers: boolean;
  /** Report contexts reassigned in loops. */
  checkLoops: boolean;
  /** Report contexts reassigned in function literals. */
  checkFunctionLiterals: boolean;
}

const inLoop = "nested context in loop";
const inFuncLit = "nested context in function literal";
const inStructPointer = "potential nested context in struct pointer";
const unsupported = "unsupported nested context type";

export default defineAnalyzer<Config>({
  name: "fatcontext",
  doc: `detect nested contexts in loops and function literals

Reassigning a context derived from itself, as ctx = context.WithValue(ctx, ...),
in a loop or a function called repeatedly nests a new layer each time, so the
context grows without bound.`,
  requires: [inspect],
  config: { checkStructPointers: false, checkLoops: true, checkFunctionLiterals: true },
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.ForStmt, ast.RangeStmt, ast.FuncLit, ast.FuncDecl)) {
      check(pass, cursor);
    }
  },
});

function check(pass: Pass<Config>, cursor: inspector.Cursor): void {
  const node = cursor.node() as ast.ForStmt | ast.RangeStmt | ast.FuncLit | ast.FuncDecl;
  if (node.$type === "FuncLit" && isRunOnce(pass, cursor)) {
    return;
  }
  if (node.body === null) {
    return;
  }
  const assign = findNestedContext(pass, node, node.body.list);
  if (assign === null) {
    return;
  }
  const category = categoryOf(pass, node, assign);
  if (
    (category === inLoop && !pass.config.checkLoops) ||
    (category === inFuncLit && !pass.config.checkFunctionLiterals) ||
    (category === inStructPointer && !pass.config.checkStructPointers)
  ) {
    return;
  }
  const fixable = category === inLoop || category === inFuncLit;
  const list = (exprs: (ast.Expr | null)[]) => exprs.map((e) => formatNode(e!, pass.fset)).join(", ");
  pass.report({
    pos: assign.pos(),
    message: category,
    suggestedFixes: fixable
      ? [{ message: "replace `=` with `:=`", textEdits: [{ pos: assign.pos(), end: assign.end(), newText: `${list(assign.lhs)} := ${list(assign.rhs)}` }] }]
      : [],
  });
}

// isRunOnce reports whether a function literal runs at most once per
// execution of the statement registering it, as with defer func() {}() or
// t.Cleanup(func() {}), outside any loop.
function isRunOnce(pass: Pass<Config>, cursor: inspector.Cursor): boolean {
  const parent = cursor.parent();
  const call = parent.node();
  if (call?.$type !== "CallExpr") {
    return false;
  }
  const runOnce = call.fun === cursor.node() ? parent.parent().node()?.$type === "DeferStmt" : isCleanupCall(pass, call);
  return runOnce && cursor.enclosing(ast.ForStmt, ast.RangeStmt).toArray().length === 0;
}

// isCleanupCall reports whether a call is to testing.T, B, or TB's Cleanup.
function isCleanupCall(pass: Pass<Config>, call: ast.CallExpr): boolean {
  const fun = call.fun;
  if (fun?.$type !== "SelectorExpr" || fun.sel!.name !== "Cleanup") {
    return false;
  }
  let t = pass.typesInfo.typeOf(fun.x);
  if (t?.$type === "Pointer") {
    t = t.elem();
  }
  const object = t?.$type === "Named" ? t.obj() : null;
  return object?.pkg()?.path() === "testing" && ["T", "B", "TB"].includes(object.name());
}

function categoryOf(pass: Pass<Config>, node: ast.Node, assign: ast.AssignStmt): string {
  if (node.$type === "ForStmt" || node.$type === "RangeStmt") {
    return inLoop;
  }
  if (isPointer(pass, assign.lhs[0])) {
    return inStructPointer;
  }
  return node.$type === "FuncLit" || node.$type === "FuncDecl" ? inFuncLit : unsupported;
}

// findNestedContext finds the first assignment in statements, or blocks they
// hold, of a context variable from outside the node.
function findNestedContext(pass: Pass<Config>, node: ast.Node, stmts: (ast.Stmt | null)[]): ast.AssignStmt | null {
  // Contexts reset to an empty context in this block may be wrapped again.
  const reset = new Set<string>();
  for (const stmt of stmts) {
    const found = findNestedContext(pass, node, stmtList(stmt));
    if (found !== null) {
      return found;
    }
    if (stmt?.$type !== "AssignStmt" || stmt.tok === token.DEFINE || pass.typesInfo.typeOf(stmt.lhs[0])?.string() !== "context.Context") {
      continue;
    }
    const name = varName(pass, stmt.lhs[0]);
    if (isEmptyContext(stmt.rhs[0])) {
      if (name !== "") {
        reset.add(name);
      }
      continue;
    }
    if (name !== "" && reset.has(name)) {
      continue;
    }
    if (isPointer(pass, stmt.lhs[0])) {
      return stmt;
    }
    // A field of a value declared within the node is a fresh copy.
    if (isWithin(pass, stmt.lhs[0], node)) {
      continue;
    }
    return stmt;
  }
  return null;
}

function varName(pass: Pass<Config>, lhs: ast.Expr | null): string {
  if (lhs?.$type === "Ident") {
    return lhs.name;
  }
  return lhs?.$type === "SelectorExpr" ? formatNode(lhs, pass.fset) : "";
}

function stmtList(stmt: ast.Stmt | null): (ast.Stmt | null)[] {
  switch (stmt?.$type) {
    case "BlockStmt":
      return stmt.list;
    case "IfStmt":
    case "SwitchStmt":
    case "SelectStmt":
      return stmt.body!.list;
    case "CaseClause":
    case "CommClause":
      return stmt.body;
  }
  return [];
}

// isEmptyContext reports whether an expression is context.Background(),
// context.TODO(), or the Context method of a testing.T, B, or TB parameter.
function isEmptyContext(expr: ast.Expr | null): boolean {
  if (expr?.$type !== "CallExpr" || expr.fun?.$type !== "SelectorExpr" || expr.fun.x?.$type !== "Ident") {
    return false;
  }
  const ident = expr.fun.x;
  const name = expr.fun.sel!.name;
  if (ident.name === "context" && (name === "Background" || name === "TODO")) {
    return true;
  }
  if (name !== "Context") {
    return false;
  }
  const decl = ident.obj?.decl as ast.Node | null | undefined;
  if (decl?.$type !== "Field") {
    return false;
  }
  const declType = decl.type?.$type === "StarExpr" ? decl.type.x : decl.type;
  return declType?.$type === "SelectorExpr" && declType.x?.$type === "Ident" && declType.x.name === "testing" && ["T", "B", "TB"].includes(declType.sel!.name);
}

// isWithin reports whether an assignment target's root variable is declared
// inside the node, without passing through a pointer.
function isWithin(pass: Pass<Config>, expr: ast.Expr | null, node: ast.Node): boolean {
  const root = rootIdent(pass, expr);
  const scope = root === null ? null : (pass.typesInfo.objectOf(root)?.parent() ?? null);
  return scope !== null && scope.pos() >= node.pos() && scope.end() <= node.end();
}

function rootIdent(pass: Pass<Config>, expr: ast.Expr | null): ast.Ident | null {
  for (;;) {
    switch (expr?.$type) {
      case "Ident":
        return expr;
      case "IndexExpr":
        expr = expr.x;
        break;
      case "SelectorExpr":
        if (selection(pass, expr)?.indirect()) {
          return null;
        }
        expr = expr.x;
        break;
      default:
        return null;
    }
  }
}

function isPointer(pass: Pass<Config>, expr: ast.Expr | null): boolean {
  return expr?.$type === "SelectorExpr" && (selection(pass, expr)?.indirect() ?? false);
}

function selection(pass: Pass<Config>, sel: ast.SelectorExpr): types.Selection | null {
  return pass.typesInfo.selections.get(sel) ?? null;
}
