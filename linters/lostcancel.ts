// Port of golang.org/x/tools/go/analysis/passes/lostcancel at v0.50.0.
import * as ast from "go/ast";
import type * as types from "go/types";
import type * as cfg from "golang.org/x/tools/go/cfg";
import { defineAnalyzer, type Pass } from "tsk";
import { ctrlflow, inspect } from "tsk/passes";
import { imports } from "./internal/typesinternal";

const contextPackage = "context";

const withCancelFuncs = new Set(["WithCancel", "WithCancelCause", "WithTimeout", "WithTimeoutCause", "WithDeadline", "WithDeadlineCause"]);

export default defineAnalyzer({
  name: "lostcancel",
  doc: `check cancel func returned by context.WithCancel is called

The cancellation function returned by context.WithCancel, WithTimeout,
WithDeadline and variants such as WithCancelCause must be called,
or the new context will remain live until its parent context is cancelled.
(The background context is never cancelled.)`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/lostcancel",
  requires: [inspect, ctrlflow],
  run(pass) {
    if (!imports(pass.pkg, contextPackage)) {
      return;
    }
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.FuncLit, ast.FuncDecl)) {
      runFunc(pass, cursor.node() as ast.FuncLit | ast.FuncDecl);
    }
  },
});

// runFunc reports cancel variables of one function that are discarded, or
// that some path to a return statement does not use.
function runFunc(pass: Pass<unknown>, node: ast.FuncLit | ast.FuncDecl): void {
  const info = pass.typesInfo;
  const funcScope = info.scopes.get(node.type!) ?? null;

  // Maps each cancel variable to its defining ValueSpec or AssignStmt.
  const cancelVars = new Map<types.Var, ast.Node>();
  ast.preorderStack(node, [], (n, stack) => {
    if (n === null || (n.$type === "FuncLit" && stack.length > 0)) {
      return false;
    }
    // Look for "ctx, cancel := context.WithCancel(...)" and its "=" and
    // "var" forms.
    if (!isContextWithCancel(info, n) || stack[stack.length - 1]?.$type !== "CallExpr") {
      return true;
    }
    const stmt = stack[stack.length - 2];
    let id: ast.Ident | null = null;
    if (stmt?.$type === "ValueSpec" && stmt.names.length > 1) {
      id = stmt.names[1];
    } else if (stmt?.$type === "AssignStmt" && stmt.lhs.length > 1) {
      const lhs = stmt.lhs[1];
      id = lhs?.$type === "Ident" ? lhs : null;
    }
    if (id === null || stmt === null) {
      return true;
    }
    if (id.name === "_") {
      const sel = (n as ast.SelectorExpr).sel!.name;
      pass.report({
        pos: id.pos(),
        end: id.end(),
        message: `the cancel function returned by context.${sel} should be called, not discarded, to avoid a context leak`,
      });
      return true;
    }
    const used = info.uses.get(id);
    if (used?.$type === "Var") {
      // A cancel variable declared outside the function is not analyzed.
      if (funcScope?.contains(used.pos())) {
        cancelVars.set(used, stmt);
      }
      return true;
    }
    const defined = info.defs.get(id);
    if (defined?.$type === "Var") {
      cancelVars.set(defined, stmt);
    }
    return true;
  });
  if (cancelVars.size === 0) {
    return;
  }

  const cfgs = pass.resultOf(ctrlflow);
  let g: cfg.CFG | null;
  let sig: types.Type | null | undefined;
  if (node.$type === "FuncDecl") {
    sig = info.defs.get(node.name!)?.type();
    // Returning from main.main terminates the process, so contexts need no cancelling.
    if (sig?.$type === "Signature" && sig.recv() === null && node.name!.name === "main" && pass.pkg.name() === "main") {
      return;
    }
    g = cfgs.funcDecl(node);
  } else {
    sig = info.types.get(node.type!)?.type;
    g = cfgs.funcLit(node);
  }
  if (sig?.$type !== "Signature" || g === null) {
    return;
  }

  for (const [v, stmt] of cancelVars) {
    const ret = lostCancelPath(pass, g, v, stmt, sig);
    if (ret === null) {
      continue;
    }
    const line = pass.fset.position(stmt.pos()).line;
    pass.report({ pos: stmt.pos(), end: stmt.end(), message: `the ${v.name()} function is not used on all paths (possible context leak)` });
    const pos = ret.pos();
    let end = ret.end();
    // A synthetic ReturnStmt may overflow the file (golang/go#64547).
    if (pass.fset.file(pos) !== pass.fset.file(end)) {
      end = pos;
    }
    pass.report({ pos, end, message: `this return statement may be reached without using the ${v.name()} var defined on line ${line}` });
  }
}

// isContextWithCancel reports whether n is one of the qualified identifiers
// context.With{Cancel,Timeout,Deadline} or their Cause variants.
function isContextWithCancel(info: types.Info, n: ast.Node): boolean {
  if (n.$type !== "SelectorExpr" || !withCancelFuncs.has(n.sel!.name)) {
    return false;
  }
  const x = n.x;
  if (x?.$type !== "Ident") {
    return false;
  }
  const pkgName = info.uses.get(x);
  if (pkgName?.$type === "PkgName") {
    return pkgName.imported()!.path() === contextPackage;
  }
  // Without a resolved import, fall back to the local package name.
  return x.name === "context";
}

// lostCancelPath finds a path through the CFG from stmt, which defines the
// cancel variable v, to a return statement that does not use v.
function lostCancelPath(pass: Pass<unknown>, g: cfg.CFG, v: types.Var, stmt: ast.Node, sig: types.Signature): ast.ReturnStmt | null {
  const results = sig.results();
  let vIsNamedResult = false;
  for (let i = 0; results !== null && i < results.len(); i++) {
    if (results.at(i) === v) {
      vIsNamedResult = true;
    }
  }

  // uses reports whether stmts refer to v; a naked return uses named results.
  const uses = (stmts: readonly (ast.Node | null)[]): boolean => {
    let found = false;
    for (const s of stmts) {
      ast.inspect(s, (n) => {
        if (n?.$type === "Ident" && pass.typesInfo.uses.get(n) === v) {
          found = true;
        } else if (n?.$type === "ReturnStmt" && n.results.length === 0 && vIsNamedResult) {
          found = true;
        }
        return !found;
      });
    }
    return found;
  };

  const memo = new Map<cfg.Block, boolean>();
  const blockUses = (b: cfg.Block): boolean => {
    let res = memo.get(b);
    if (res === undefined) {
      res = uses(b.nodes);
      memo.set(b, res);
    }
    return res;
  };

  // Find the defining block and the statements after stmt in it.
  let defBlock: cfg.Block | null = null;
  let rest: (ast.Node | null)[] = [];
  for (const b of g.blocks) {
    const i = b!.nodes.indexOf(stmt);
    if (i >= 0) {
      defBlock = b;
      rest = b!.nodes.slice(i + 1);
      break;
    }
  }
  if (defBlock === null) {
    throw new Error("internal error: can't find defining block for cancel var");
  }
  if (uses(rest)) {
    return null;
  }
  const defReturn = defBlock.return();
  if (defReturn !== null) {
    return defReturn;
  }

  // Search depth-first for a path to a return block that never uses v.
  const seen = new Set<cfg.Block>();
  const search = (blocks: readonly (cfg.Block | null)[]): ast.ReturnStmt | null => {
    for (const b of blocks) {
      if (b === null || seen.has(b)) {
        continue;
      }
      seen.add(b);
      if (blockUses(b)) {
        continue;
      }
      const ret = b.return();
      if (ret !== null) {
        return ret;
      }
      const found = search(b.succs);
      if (found !== null) {
        return found;
      }
    }
    return null;
  };
  return search(defBlock.succs);
}
