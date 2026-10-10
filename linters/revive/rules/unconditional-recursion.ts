import type * as ast from "go/ast";
import { isCallToExitFunction, isIdent, seekNode, type Visitor, walk } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "unconditional-recursion";

export function create(): Rule {
  return { name, apply };
}

// A function by its receiver's name, or null without one, and its name.
interface FuncDesc {
  receiver: string | null;
  name: string;
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  for (const decl of file.ast.decls) {
    if (decl!.$type !== "FuncDecl") {
      continue;
    }
    const fn = decl as ast.FuncDecl;
    if (fn.body === null) {
      continue;
    }
    let receiver: string | null = null;
    if (fn.recv !== null) {
      receiver = fn.recv.numFields() < 1 || fn.recv.list[0]!.names.length < 1 ? "_" : fn.recv.list[0]!.names[0]!.name;
    }
    checkBody({ receiver, name: fn.name!.name }, fn.body, failures);
  }
  return failures;
}

// Looks for calls to fn outside conditional control structures, until it
// finds a conditional exit from the function.
function checkBody(fn: FuncDesc, body: ast.BlockStmt, failures: Failure[]): void {
  let seenConditionalExit = false;
  let inGoStatement = false;
  const updateFuncStatus = (node: ast.Node | null) => {
    if (node !== null && !seenConditionalExit) {
      seenConditionalExit = seekNode(node, isExit) !== null;
    }
  };
  const visitor: Visitor = {
    visit(node) {
      if (node === null) {
        return null;
      }
      switch (node.$type) {
        case "CallExpr": {
          const call = node as ast.CallExpr;
          for (const arg of call.args) {
            walk(visitor, arg!);
          }
          const fun = call.fun!;
          let receiver: string | null = null;
          let funcName: string;
          switch (fun.$type) {
            case "Ident":
              funcName = (fun as ast.Ident).name;
              break;
            case "SelectorExpr": {
              const sel = fun as ast.SelectorExpr;
              // a.b....Foo()
              if (sel.x!.$type !== "Ident") {
                return null;
              }
              receiver = (sel.x as ast.Ident).name;
              funcName = sel.sel!.name;
              break;
            }
            case "FuncLit":
              walk(visitor, (fun as ast.FuncLit).body!);
              return null;
            default:
              return visitor;
          }
          if (!seenConditionalExit && receiver === fn.receiver && funcName === fn.name) {
            failures.push({ failure: "unconditional recursive call", confidence: 0.8, node: call });
          }
          return null;
        }
        case "IfStmt":
          updateFuncStatus((node as ast.IfStmt).body);
          updateFuncStatus((node as ast.IfStmt).else);
          return null;
        case "SelectStmt":
        case "RangeStmt":
        case "TypeSwitchStmt":
        case "SwitchStmt":
          updateFuncStatus((node as ast.SelectStmt | ast.RangeStmt | ast.TypeSwitchStmt | ast.SwitchStmt).body);
          return null;
        case "GoStmt":
          inGoStatement = true;
          walk(visitor, (node as ast.GoStmt).call!);
          inGoStatement = false;
          return null;
        case "ForStmt":
          // Only an unconditional loop is searched.
          return (node as ast.ForStmt).cond === null ? visitor : null;
        case "FuncLit":
          // A closure is not necessarily called, unless it is started by go.
          return inGoStatement ? visitor : null;
      }
      return visitor;
    },
  };
  walk(visitor, body);
}

// Reports whether node makes control exit the function.
function isExit(node: ast.Node): boolean {
  if (node.$type === "ReturnStmt") {
    return true;
  }
  if (node.$type !== "CallExpr") {
    return false;
  }
  const call = node as ast.CallExpr;
  if (isIdent(call.fun, "panic")) {
    return true;
  }
  if (call.fun!.$type !== "SelectorExpr") {
    return false;
  }
  const sel = call.fun as ast.SelectorExpr;
  if (sel.x!.$type !== "Ident") {
    return false;
  }
  return isCallToExitFunction((sel.x as ast.Ident).name, sel.sel!.name, call.args);
}
