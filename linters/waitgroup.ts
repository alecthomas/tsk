// Port of golang.org/x/tools/go/analysis/passes/waitgroup at v0.50.0.
import * as ast from "go/ast";
import type * as inspector from "golang.org/x/tools/go/ast/inspector";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";
import { imports, isMethodNamed } from "./internal/typesinternal";

// The ancestors of the call, innermost first, in go func() { wg.Add(1); ... }().
const wantAncestors = ["ExprStmt", "BlockStmt", "FuncLit", "CallExpr", "GoStmt"];

export default defineAnalyzer({
  name: "waitgroup",
  doc: `check for misuses of sync.WaitGroup

This analyzer detects mistaken calls to the (*sync.WaitGroup).Add
method from inside a new goroutine, causing Add to race with Wait:

	// WRONG
	var wg sync.WaitGroup
	go func() {
	        wg.Add(1) // "WaitGroup.Add called from inside new goroutine"
	        defer wg.Done()
	        ...
	}()
	wg.Wait() // (may return prematurely before new goroutine starts)

The correct code calls Add before starting the goroutine:

	// RIGHT
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		...
	}()
	wg.Wait()`,
  group: "govet",
  requires: [inspect],
  run(pass) {
    if (!imports(pass.pkg, "sync")) {
      return;
    }
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      if (isMethodNamed(typeutil.callee(pass.typesInfo, call), "sync", "WaitGroup", "Add") && isFirstStmtOfGoFuncLit(cursor)) {
        pass.report({ pos: call.lparen, message: "WaitGroup.Add called from inside new goroutine" });
      }
    }
  },
});

// isFirstStmtOfGoFuncLit reports whether the call is the first statement of
// a function literal in a go statement's call.
function isFirstStmtOfGoFuncLit(cursor: inspector.Cursor): boolean {
  const ancestors: (ast.Node | null)[] = [];
  let c = cursor;
  for (const want of wantAncestors) {
    c = c.parent();
    const node = c.node();
    if (node?.$type !== want) {
      return false;
    }
    ancestors.push(node);
  }
  const [stmt, block] = ancestors;
  return block?.$type === "BlockStmt" && block.list[0] === stmt;
}
