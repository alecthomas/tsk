import * as ast from "go/ast";
import { isIdent, walk, type Visitor } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "defer";

type Subcase = "loop" | "call-chain" | "method-call" | "return" | "recover" | "immediate-recover";

export interface Options {
  /** The checks to run: loop, call-chain, method-call, return, recover, and immediate-recover. */
  allow: Subcase[];
}

export const defaults: Options = { allow: ["loop", "call-chain", "method-call", "return", "recover", "immediate-recover"] };

export function create(options: DeepReadonly<Options>): Rule {
  const allow = new Set<Subcase>(options.allow);
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      const report = (failure: string, node: ast.Node, confidence: number, subcase: Subcase) => {
        if (allow.has(subcase)) {
          failures.push({ failure, node, confidence });
        }
      };
      walk(deferVisitor(report, { inALoop: false, inADefer: false, inAFuncLit: 0 }), file.ast);
      return failures;
    },
  };
}

type Report = (failure: string, node: ast.Node, confidence: number, subcase: Subcase) => void;

interface State {
  inALoop: boolean;
  inADefer: boolean;
  /** 0 outside a function literal, 1 in a top-level one, more when nested. */
  inAFuncLit: number;
}

const immediateRecover = "recover must be called inside a deferred function, this is executing recover immediately";

function deferVisitor(report: Report, state: State): Visitor {
  const subtree = (n: ast.Node, inADefer: boolean, inALoop: boolean, inAFuncLit: number) => {
    walk(deferVisitor(report, { inADefer, inALoop, inAFuncLit }), n);
  };
  const visitor: Visitor = {
    visit(node) {
      if (node === null) {
        return visitor;
      }
      switch (node.$type) {
        case "ForStmt":
        case "RangeStmt":
          subtree(node.body!, state.inADefer, true, state.inAFuncLit);
          return null;
        case "FuncLit":
          subtree(node.body!, state.inADefer, false, state.inAFuncLit + 1);
          return null;
        case "ReturnStmt":
          if (node.results.length !== 0 && state.inADefer && state.inAFuncLit === 1) {
            report("return in a defer function has no effect", node, 1, "return");
          }
          break;
        case "CallExpr": {
          const isCallToRecover = isIdent(node.fun, "recover");
          if (!state.inADefer && isCallToRecover) {
            // Not 1, since the function may be deferred elsewhere.
            report("recover must be called inside a deferred function", node, 0.8, "recover");
          } else if (state.inADefer && state.inAFuncLit === 0 && isCallToRecover) {
            report(immediateRecover, node, 1, "immediate-recover");
          }
          return null;
        }
        case "DeferStmt": {
          const call = node.call!;
          if (isIdent(call.fun, "recover")) {
            report(immediateRecover, node, 1, "immediate-recover");
          }
          subtree(call.fun!, true, false, 0);
          for (const arg of call.args) {
            // Deferred calls with function literal arguments are too hard to analyse.
            if (arg!.$type !== "FuncLit") {
              subtree(arg!, true, false, 0);
            }
          }
          if (state.inALoop) {
            report("prefer not to defer inside loops", node, 1, "loop");
          }
          const fun = call.fun!;
          if (fun.$type === "CallExpr") {
            report("prefer not to defer chains of function calls", fun, 1, "call-chain");
          } else if (fun.$type === "SelectorExpr" && fun.x!.$type === "Ident") {
            const obj = (fun.x as ast.Ident).obj;
            if (obj !== null && obj.kind === ast.Typ) {
              report("be careful when deferring calls to methods without pointer receiver", fun, 0.8, "method-call");
            }
          }
          return null;
        }
      }
      return visitor;
    },
  };
  return visitor;
}
