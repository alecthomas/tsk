// Port of golang.org/x/tools/go/analysis/passes/testinggoroutine at v0.50.0.
import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";
import { imports, usedIdent } from "./internal/typesinternal";

// An asyncCall is a region of code started asynchronously by a go fun() or
// t.Run(name, fun), to check for t.Forbidden() calls.
interface AsyncCall {
  region: ast.Node;
  // The *ast.GoStmt or the t.Run *ast.CallExpr.
  async: ast.Node;
  // Calls are reported when t is not declared within scope.
  scope: ast.Node | null;
  fun: ast.Expr;
}

const forbidden = ["FailNow", "Fatal", "Fatalf", "Skip", "Skipf", "SkipNow"];

export default defineAnalyzer({
  name: "testinggoroutine",
  doc: `report calls to (*testing.T).Fatal from goroutines started by a test

Functions that abruptly terminate a test, such as the Fatal, Fatalf, FailNow, and
Skip{,f,Now} methods of *testing.T, must be called from the test goroutine itself.
This checker detects calls to these functions that occur within a goroutine
started by the test. For example:

	func TestFoo(t *testing.T) {
	    go func() {
	        t.Fatal("oops") // error: (*T).Fatal called from non-test goroutine
	    }()
	}`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/testinggoroutine",
  requires: [inspect],
  run(pass) {
    if (!imports(pass.pkg, "testing")) {
      return;
    }
    const info = pass.typesInfo;
    const toDecl = localFunctionDecls(info, pass.files);

    // asyncs maps each region to the call sites that start it asynchronously.
    const asyncs = new Map<ast.Node, AsyncCall[]>();
    const addCall = (c: AsyncCall | null) => {
      if (c !== null) {
        const calls = asyncs.get(c.region);
        if (calls === undefined) {
          asyncs.set(c.region, [c]);
        } else {
          calls.push(c);
        }
      }
    };

    pass
      .resultOf(inspect)
      .root()
      .inspect([ast.FuncDecl, ast.GoStmt, ast.CallExpr], (cursor) => {
        const node = cursor.node()!;
        switch (node.$type) {
          case "FuncDecl":
            return hasBenchmarkOrTestParams(node);
          case "GoStmt":
            addCall(goAsyncCall(info, node, toDecl));
            break;
          case "CallExpr":
            addCall(tRunAsyncCall(info, node));
            break;
        }
        return true;
      });

    for (const [region, calls] of asyncs) {
      ast.inspect(region, (n) => {
        if (n === region) {
          return true;
        }
        if (n === null || asyncs.has(n)) {
          // Another region visits it.
          return false;
        }
        if (n.$type !== "CallExpr") {
          return true;
        }
        const method = forbiddenMethod(info, n);
        if (method === null) {
          return true;
        }
        const { x, sel, fn } = method;
        for (const e of calls) {
          if (withinScope(e.scope, x)) {
            continue;
          }
          const name = formatMethod(sel, fn);
          let context = "";
          // Report at the go fun() or t.Run(name, fun), or at the call if fun is local.
          let where: ast.Node = e.async;
          if (e.fun.$type === "FuncLit") {
            where = n;
          } else if (e.fun.$type === "Ident") {
            context = ` (${e.fun.name} calls ${name})`;
          }
          // Upstream's test-only subtest flag also reports t.Run subtests; it is not ported.
          if (e.async.$type === "GoStmt") {
            pass.report({ pos: where.pos(), end: where.end(), message: `call to ${name} from a non-test goroutine${context}` });
          }
        }
        return true;
      });
    }
  },
});

function hasBenchmarkOrTestParams(fnDecl: ast.FuncDecl): boolean {
  return fnDecl.type!.params!.list.some((param) => isTestingDotTOrB(param!.type!));
}

function isTestingDotTOrB(expr: ast.Expr): boolean {
  if (expr.$type !== "StarExpr" || expr.x?.$type !== "SelectorExpr") {
    return false;
  }
  const sel = expr.x;
  if (sel.x?.$type !== "Ident" || sel.x.name !== "testing") {
    return false;
  }
  return sel.sel!.name === "B" || sel.sel!.name === "T";
}

// withinScope reports whether x is declared within scope.
function withinScope(scope: ast.Node | null, x: types.Var): boolean {
  return scope !== null && x.pos() !== token.NoPos && scope.pos() <= x.pos() && x.pos() <= scope.end();
}

// goAsyncCall returns the region a go fun() statement runs.
function goAsyncCall(info: types.Info, goStmt: ast.GoStmt, toDecl: (fn: types.Func | null) => ast.FuncDecl | undefined): AsyncCall {
  const call = goStmt.call!;
  const fun = ast.unparen(call.fun)!;
  const id = usedIdent(info, fun);
  if (id !== null) {
    const lit = funcLitInScope(id);
    if (lit !== null) {
      return { region: lit, async: goStmt, scope: null, fun };
    }
  }
  const decl = toDecl(typeutil.staticCallee(info, call));
  if (decl !== undefined) {
    return { region: decl, async: goStmt, scope: null, fun };
  }
  // Check the go statement itself, for go t.Forbidden() or go func(){t.Forbidden()}().
  return { region: goStmt, async: goStmt, scope: null, fun };
}

// tRunAsyncCall returns the region a t.Run("name", fun) call runs.
function tRunAsyncCall(info: types.Info, call: ast.CallExpr): AsyncCall | null {
  if (call.args.length !== 2) {
    return null;
  }
  const run = typeutil.callee(info, call);
  if (run?.$type !== "Func" || !isMethodNamed(run, "testing", "Run")) {
    return null;
  }
  const fun = ast.unparen(call.args[1])!;
  if (fun.$type === "FuncLit") {
    return { region: fun, async: call, scope: fun, fun };
  }
  const id = usedIdent(info, fun);
  if (id !== null) {
    const lit = funcLitInScope(id);
    if (lit !== null) {
      return { region: lit, async: call, scope: lit, fun };
    }
  }
  return { region: call, async: call, scope: fun, fun };
}

// forbiddenMethod decomposes a call x.m() where x is a variable and m is a
// forbidden testing method, or returns null.
function forbiddenMethod(info: types.Info, call: ast.CallExpr): { x: types.Var; sel: types.Selection; fn: types.Func } | null {
  const fun = ast.unparen(call.fun);
  if (fun?.$type !== "SelectorExpr") {
    return null;
  }
  const sel = info.selections.get(fun);
  if (sel === null || sel === undefined) {
    return null;
  }
  const id = ast.unparen(fun.x);
  const x = id?.$type === "Ident" ? info.uses.get(id) : null;
  if (x?.$type !== "Var") {
    return null;
  }
  const fn = sel.obj();
  if (fn?.$type !== "Func" || !isMethodNamed(fn, "testing", ...forbidden)) {
    return null;
  }
  return { x, sel, fn };
}

function formatMethod(sel: types.Selection, fn: types.Func): string {
  let ptr = "";
  let rtype = sel.recv()!;
  const p = types.unalias(rtype);
  if (p?.$type === "Pointer") {
    ptr = "*";
    rtype = p.elem()!;
  }
  return `(${ptr}${rtype.string()}).${fn.name()}`;
}

// localFunctionDecls returns a lookup, built lazily, of the package's
// function declarations by their objects.
function localFunctionDecls(info: types.Info, files: readonly ast.File[]): (fn: types.Func | null) => ast.FuncDecl | undefined {
  let fnDecls: Map<types.Func, ast.FuncDecl> | null = null;
  return (fn) => {
    if (fn === null) {
      return undefined;
    }
    if (fnDecls === null) {
      fnDecls = new Map();
      for (const file of files) {
        for (const decl of file.decls) {
          if (decl?.$type === "FuncDecl") {
            const obj = info.defs.get(decl.name!);
            if (obj?.$type === "Func") {
              fnDecls.set(obj, decl);
            }
          }
        }
      }
    }
    return fnDecls.get(fn);
  };
}

// isMethodNamed reports whether f is a method in pkgPath with one of the
// names, whatever its receiver type.
function isMethodNamed(f: types.Func, pkgPath: string, ...names: string[]): boolean {
  return f.pkg()?.path() === pkgPath && f.signature()!.recv() !== null && names.includes(f.name());
}

// funcLitInScope returns the function literal id is initially assigned, using
// the deprecated syntactic object resolution.
function funcLitInScope(id: ast.Ident): ast.FuncLit | null {
  const decl = id.obj?.decl as ast.Node | null | undefined;
  let rhs: ast.Expr | null = null;
  if (decl?.$type === "AssignStmt") {
    for (const [i, x] of decl.lhs.entries()) {
      if (x?.$type === "Ident" && x.name === id.name && i < decl.rhs.length) {
        rhs = decl.rhs[i];
      }
    }
  } else if (decl?.$type === "ValueSpec") {
    for (const [i, n] of decl.names.entries()) {
      if (n!.name === id.name && i < decl.values.length) {
        rhs = decl.values[i];
      }
    }
  }
  return rhs?.$type === "FuncLit" ? rhs : null;
}
