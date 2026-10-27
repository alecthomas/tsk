// Port of golang.org/x/tools/go/analysis/passes/sigchanyzer at v0.50.0.
import * as ast from "go/ast";
import type * as types from "go/types";
import { defineAnalyzer, formatNode } from "tsk";
import { inspect } from "tsk/passes";
import { imports } from "./internal/typesinternal";

export default defineAnalyzer({
  name: "sigchanyzer",
  doc: `check for unbuffered channel of os.Signal

This checker reports call expression of the form

	signal.Notify(c <-chan os.Signal, sig ...os.Signal),

where c is an unbuffered channel, which can be at risk of missing the signal.`,
  group: "govet",
  requires: [inspect],
  run(pass) {
    if (!imports(pass.pkg, "os/signal")) {
      return;
    }
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      if (!isSignalNotify(pass.typesInfo, call)) {
        continue;
      }
      let chanDecl: ast.CallExpr | null = null;
      const arg = call.args[0]!;
      if (arg.$type === "Ident") {
        const decl = findDecl(arg);
        if (decl?.$type === "CallExpr") {
          chanDecl = decl;
        }
      } else if (arg.$type === "CallExpr") {
        // Only signal.Notify(make(chan os.Signal), ...) is known to be
        // unbuffered; see golang/go#45043.
        if (isBuiltinMake(pass.typesInfo, arg)) {
          continue;
        }
        chanDecl = arg;
      }
      if (chanDecl === null || chanDecl.args.length !== 1) {
        continue;
      }
      // Upstream prints a copy of the call with an extra argument; appending
      // it to the formatted call before its closing parenthesis is equivalent.
      const text = formatNode(chanDecl);
      pass.report({
        pos: call.pos(),
        end: call.end(),
        message: "misuse of unbuffered os.Signal channel as argument to signal.Notify",
        suggestedFixes: [
          {
            message: "Change to buffer channel",
            textEdits: [{ pos: chanDecl.pos(), end: chanDecl.end(), newText: `${text.slice(0, -1)}, 1)` }],
          },
        ],
      });
    }
  },
});

function isSignalNotify(info: types.Info, call: ast.CallExpr): boolean {
  const check = (id: ast.Ident | null): boolean => {
    const obj = info.objectOf(id);
    return obj?.name() === "Notify" && obj.pkg()?.path() === "os/signal";
  };
  const fun = call.fun;
  if (fun?.$type === "SelectorExpr") {
    return check(fun.sel);
  }
  if (fun?.$type === "Ident") {
    const decl = findDecl(fun);
    return decl?.$type === "SelectorExpr" && check(decl.sel);
  }
  return false;
}

// Finds the expression assigned to an identifier where it is declared, using
// go/parser's syntactic object resolution, as upstream does.
function findDecl(arg: ast.Ident): ast.Node | null {
  if (arg.obj === null) {
    return null;
  }
  const decl = arg.obj.decl as ast.Node | null;
  if (decl?.$type === "AssignStmt") {
    if (decl.lhs.length !== decl.rhs.length) {
      return null;
    }
    for (const [i, lhs] of decl.lhs.entries()) {
      if (lhs?.$type === "Ident" && lhs.obj === arg.obj) {
        return decl.rhs[i]!;
      }
    }
  } else if (decl?.$type === "ValueSpec") {
    if (decl.names.length !== decl.values.length) {
      return null;
    }
    for (const [i, name] of decl.names.entries()) {
      if (name!.obj === arg.obj) {
        return decl.values[i]!;
      }
    }
  }
  return null;
}

function isBuiltinMake(info: types.Info, call: ast.CallExpr): boolean {
  if (!info.types.get(call.fun!)?.isBuiltin()) {
    return false;
  }
  return call.fun?.$type === "Ident" && info.objectOf(call.fun)?.name() === "make";
}
