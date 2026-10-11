// Port of golang.org/x/tools/go/analysis/passes/httpresponse at v0.50.0.
import * as ast from "go/ast";
import * as types from "go/types";
import type { Cursor } from "golang.org/x/tools/go/ast/inspector";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";
import { imports, isTypeNamed, receiverNamed } from "./internal/typesinternal";

export default defineAnalyzer({
  name: "httpresponse",
  doc: `check for mistakes using HTTP responses

A common mistake when using the net/http package is to defer a function
call to close the http.Response Body before checking the error that
determines whether the response is valid:

	resp, err := http.Head(url)
	defer resp.Body.Close()
	if err != nil {
		log.Fatal(err)
	}
	// (defer statement belongs here)

This checker helps uncover latent nil dereference bugs by reporting a
diagnostic for such mistakes.`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/httpresponse",
  requires: [inspect],
  run(pass) {
    if (!imports(pass.pkg, "net/http")) {
      return;
    }
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      if (!isHTTPFuncOrMethodOnClient(pass.typesInfo, call)) {
        continue;
      }
      const { stmts, ncalls } = restOfBlock(cursor);
      // Skip a call that is the last statement of its block, or is wrapped by
      // another, as in checkError(http.Get(url)) (#52661).
      if (stmts.length < 2 || ncalls > 1) {
        continue;
      }
      const asg = stmts[0]!;
      if (asg.$type !== "AssignStmt") {
        continue;
      }
      const resp = rootIdent(asg.lhs[0]!);
      const def = stmts[1]!;
      if (resp === null || def.$type !== "DeferStmt") {
        continue;
      }
      const root = rootIdent(def.call!.fun!);
      // Like upstream, this compares the parser's legacy objects, which are both
      // null for unresolved identifiers.
      if (root !== null && resp.obj === root.obj) {
        pass.report({ pos: root.pos(), end: root.end(), message: `using ${resp.name} before checking for errors` });
      }
    }
  },
});

// isHTTPFuncOrMethodOnClient reports whether call calls a net/http function, or
// a method of http.Client, that returns (*http.Response, error).
function isHTTPFuncOrMethodOnClient(info: types.Info, call: ast.CallExpr): boolean {
  const fun = call.fun;
  if (fun?.$type !== "SelectorExpr") {
    return false;
  }
  const sig = info.types.get(fun)?.type ?? null;
  if (sig?.$type !== "Signature") {
    return false;
  }
  const res = sig.results();
  if (res === null || res.len() !== 2) {
    return false;
  }
  const { isPtr, named } = receiverNamed(res.at(0)!);
  if (!isPtr || named === null || !isTypeNamed(named, "net/http", "Response")) {
    return false;
  }
  const errorType = types.Universe!.lookup("error")!.type();
  if (!types.identical(res.at(1)!.type(), errorType)) {
    return false;
  }
  const typ = info.types.get(fun.x!)?.type ?? null;
  if (typ === null) {
    // A function in the net/http package.
    return fun.x?.$type === "Ident" && fun.x.name === "http";
  }
  if (isTypeNamed(typ, "net/http", "Client")) {
    return true;
  }
  const ptr = types.unalias(typ);
  return ptr?.$type === "Pointer" && isTypeNamed(ptr.elem(), "net/http", "Client");
}

// restOfBlock returns the statements of the innermost block enclosing the
// call, from the one containing it, and the calls up to that block.
function restOfBlock(call: Cursor): { stmts: ast.Stmt[]; ncalls: number } {
  let ncalls = 0;
  let child: Cursor | null = null;
  for (let cur = call; cur.valid() && cur.node() !== null; cur = cur.parent()) {
    const n = cur.node()!;
    if (n.$type === "BlockStmt") {
      const j = child === null ? -1 : n.list.indexOf(child.node() as ast.Stmt);
      return j < 0 ? { stmts: [], ncalls: 0 } : { stmts: n.list.slice(j) as ast.Stmt[], ncalls };
    }
    if (n.$type === "CallExpr") {
      ncalls++;
    }
    child = cur;
  }
  return { stmts: [], ncalls: 0 };
}

// rootIdent returns the root identifier x in a chain of selections x.y.z.
function rootIdent(n: ast.Node): ast.Ident | null {
  if (n.$type === "SelectorExpr") {
    return rootIdent(n.x!);
  }
  return n.$type === "Ident" ? n : null;
}
