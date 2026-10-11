// Port of golang.org/x/tools/go/analysis/passes/loopclosure at v0.50.0.
import * as ast from "go/ast";
import type * as types from "go/types";
import type * as inspector from "golang.org/x/tools/go/ast/inspector";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { fileUsesGoVersion } from "./internal/goversion";
import { isMethodNamed } from "./internal/typesinternal";

export default defineAnalyzer({
  name: "loopclosure",
  doc: `check references to loop variables from within nested functions

This analyzer reports places where a function literal references the
iteration variable of an enclosing loop, and the loop calls the function
in such a way (e.g. with go or defer) that it may outlive the loop
iteration and possibly observe the wrong value of the variable.

Note: An iteration variable can only outlive a loop iteration in Go versions <=1.21.
In Go 1.22 and later, the loop variable lifetimes changed to create a new
iteration variable per loop iteration. (See go.dev/issue/60078.)

In this example, all the deferred functions run after the loop has
completed, so all observe the final value of v [<go1.22].

	for _, v := range list {
	    defer func() {
	        use(v) // incorrect
	    }()
	}

One fix is to create a new variable for each iteration of the loop:

	for _, v := range list {
	    v := v // new var per iteration
	    defer func() {
	        use(v) // ok
	    }()
	}

After Go version 1.22, the previous two for loops are equivalent
and both are correct.

The next example uses a go statement and has a similar problem [<go1.22].
In addition, it has a data race because the loop updates v
concurrent with the goroutines accessing it.

	for _, v := range elem {
	    go func() {
	        use(v)  // incorrect, and a data race
	    }()
	}

A fix is the same as before. The checker also reports problems
in goroutines started by golang.org/x/sync/errgroup.Group.
A hard-to-spot variant of this form is common in parallel tests:

	func Test(t *testing.T) {
	    for _, test := range tests {
	        t.Run(test.name, func(t *testing.T) {
	            t.Parallel()
	            use(test) // incorrect, and a data race
	        })
	    }
	}

The t.Parallel() call causes the rest of the function to execute
concurrent with the loop [<go1.22].

The analyzer reports references only in the last statement,
as it is not deep enough to understand the effects of subsequent
statements that might render the reference benign.
("Last statement" is defined recursively in compound
statements such as if, switch, and select.)

See: https://golang.org/doc/go_faq.html#closures_and_goroutines`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/loopclosure",
  requires: [inspect],
  run(pass) {
    for (const fileCursor of pass.resultOf(inspect).root().children()) {
      // Only files whose version is strictly before go1.22 are checked.
      if (fileUsesGoVersion(pass, fileCursor.node() as ast.File, "go1.22")) {
        continue;
      }
      for (const cursor of fileCursor.preorder(ast.RangeStmt, ast.ForStmt)) {
        checkLoop(pass, cursor);
      }
    }
  },
});

function checkLoop(pass: Pass<unknown>, loop: inspector.Cursor): void {
  // Find the variables updated by the loop statement.
  const vars: types.Object[] = [];
  const addVar = (expr: ast.Expr | null) => {
    if (expr?.$type === "Ident") {
      const obj = pass.typesInfo.objectOf(expr);
      if (obj !== null) {
        vars.push(obj);
      }
    }
  };
  const n = loop.node() as ast.RangeStmt | ast.ForStmt;
  if (n.$type === "RangeStmt") {
    addVar(n.key);
    addVar(n.value);
  } else {
    const post = n.post;
    if (post?.$type === "AssignStmt") {
      // e.g. for p = head; p != nil; p = p.next
      for (const lhs of post.lhs) {
        addVar(lhs);
      }
    } else if (post?.$type === "IncDecStmt") {
      // e.g. for i := 0; i < n; i++
      addVar(post.x);
    }
  }
  if (vars.length === 0) {
    return;
  }
  const body = n.body!;

  // For go, defer, and errgroup.Group.Go, only the last statement counts, as
  // it is hard to prove go isn't followed by wait, or defer by return.
  forEachLastStmt(body.list, (last) => {
    let stmts: (ast.Stmt | null)[] = [];
    if (last.$type === "GoStmt" || last.$type === "DeferStmt") {
      stmts = litStmts(last.call!.fun);
    } else if (last.$type === "ExprStmt" && last.x?.$type === "CallExpr") {
      stmts = litStmts(goInvoke(pass.typesInfo, last.x));
    }
    for (const stmt of stmts) {
      reportCaptured(pass, loop, vars, stmt!);
    }
  });

  // Every t.Run statement in the loop body counts, as parallel subtests are
  // rarely synchronized.
  for (const s of body.list) {
    if (s?.$type === "ExprStmt" && s.x?.$type === "CallExpr") {
      for (const stmt of parallelSubtest(pass.typesInfo, s.x)) {
        reportCaptured(pass, loop, vars, stmt);
      }
    }
  }
}

// Reports references to vars in checkStmt, a statement of a function literal in the loop.
function reportCaptured(pass: Pass<unknown>, loop: inspector.Cursor, vars: types.Object[], checkStmt: ast.Stmt): void {
  const cursor = loop.findNode(checkStmt);
  if (cursor === undefined) {
    return;
  }
  for (const c of cursor.preorder(ast.Ident)) {
    const id = c.node() as ast.Ident;
    const obj = pass.typesInfo.uses.get(id) ?? null;
    if (obj === null) {
      continue;
    }
    for (const v of vars) {
      if (v === obj) {
        pass.report({ pos: id.pos(), end: id.end(), message: `loop variable ${id.name} captured by func literal` });
      }
    }
  }
}

// Calls onLast on each "last" statement in stmts, defined recursively, so
// each case of a final switch statement is visited for its last statements.
function forEachLastStmt(stmts: (ast.Stmt | null)[], onLast: (last: ast.Stmt) => void): void {
  if (stmts.length === 0) {
    return;
  }
  const s = stmts[stmts.length - 1]!;
  switch (s.$type) {
    case "IfStmt": {
      let ifStmt = s;
      for (;;) {
        forEachLastStmt(ifStmt.body!.list, onLast);
        const e = ifStmt.else;
        if (e?.$type === "BlockStmt") {
          forEachLastStmt(e.list, onLast);
          break;
        }
        if (e?.$type !== "IfStmt") {
          break;
        }
        ifStmt = e;
      }
      break;
    }
    case "ForStmt":
    case "RangeStmt":
      forEachLastStmt(s.body!.list, onLast);
      break;
    case "SwitchStmt":
    case "TypeSwitchStmt":
      for (const c of s.body!.list) {
        forEachLastStmt((c as ast.CaseClause).body, onLast);
      }
      break;
    case "SelectStmt":
      for (const c of s.body!.list) {
        forEachLastStmt((c as ast.CommClause).body, onLast);
      }
      break;
    default:
      onLast(s);
  }
}

// Returns the statements of fun's body if it is a function literal.
function litStmts(fun: ast.Expr | null): (ast.Stmt | null)[] {
  return fun?.$type === "FuncLit" ? fun.body!.list : [];
}

// Returns the function that call runs asynchronously in another goroutine,
// currently only for golang.org/x/sync/errgroup.Group.Go.
function goInvoke(info: types.Info, call: ast.CallExpr): ast.Expr | null {
  if (!isMethodCall(info, call, "golang.org/x/sync/errgroup", "Group", "Go")) {
    return null;
  }
  return call.args[0] ?? null;
}

// Returns the statements of a t.Run function literal that follow its call to
// t.Parallel after its final labeled statement, as they run concurrently with the loop.
function parallelSubtest(info: types.Info, call: ast.CallExpr): ast.Stmt[] {
  if (!isMethodCall(info, call, "testing", "T", "Run") || call.args.length !== 2) {
    return [];
  }
  const lit = call.args[1];
  if (lit?.$type !== "FuncLit") {
    return [];
  }
  const names = lit.type!.params!.list[0]!.names;
  if (names.length === 0) {
    return [];
  }
  const tObj = info.defs.get(names[0]!) ?? null;
  if (tObj === null) {
    return [];
  }
  let stmts: ast.Stmt[] = [];
  let afterParallel = false;
  for (const labeledStmt of lit.body!.list) {
    const [stmt, labeled] = unlabel(labeledStmt!);
    if (labeled) {
      // A jump could have skipped the statements considered so far.
      stmts = [];
      afterParallel = false;
    }
    if (afterParallel) {
      stmts.push(stmt);
      continue;
    }
    if (stmt.$type !== "ExprStmt" || stmt.x?.$type !== "CallExpr") {
      continue;
    }
    const parallel = stmt.x;
    if (isMethodCall(info, parallel, "testing", "T", "Parallel")) {
      const x = parallel.fun;
      if (x?.$type === "SelectorExpr" && x.x?.$type === "Ident" && info.uses.get(x.x) === tObj) {
        afterParallel = true;
      }
    }
  }
  return stmts;
}

// Strips any labels from stmt, reporting whether it had one.
function unlabel(stmt: ast.Stmt): [ast.Stmt, boolean] {
  let labeled = false;
  while (stmt.$type === "LabeledStmt") {
    labeled = true;
    stmt = stmt.stmt!;
  }
  return [stmt, labeled];
}

function isMethodCall(info: types.Info, call: ast.CallExpr, pkgPath: string, typeName: string, method: string): boolean {
  return isMethodNamed(typeutil.callee(info, call), pkgPath, typeName, method);
}
