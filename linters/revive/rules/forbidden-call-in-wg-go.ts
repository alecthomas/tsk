import type * as ast from "go/ast";
import { goFmt, isIdent, isPkgDotName, seekNode, walk, type Visitor } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "forbidden-call-in-wg-go";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  if (!file.pkg.isAtLeastGoVersion("1.25")) {
    return [];
  }
  const failures: Failure[] = [];
  const visitor: Visitor = {
    visit(node) {
      if (node === null || node.$type !== "CallExpr" || !isPkgDotName(node.fun, "wg", "Go")) {
        return visitor;
      }
      if (node.args.length !== 1 || node.args[0]!.$type !== "FuncLit") {
        return null;
      }
      const forbidden = seekNode((node.args[0] as ast.FuncLit).body, isForbiddenCall);
      if (forbidden !== null) {
        const callee = goFmt(forbidden).split("(")[0];
        failures.push({ failure: `do not call ${callee} inside wg.Go`, node: forbidden, confidence: 1 });
      }
      return null;
    },
  };
  for (const decl of file.ast.decls) {
    if (decl?.$type === "FuncDecl" && decl.body !== null) {
      walk(visitor, decl.body);
    }
  }
  return failures;
}

function isForbiddenCall(n: ast.Node): boolean {
  if (n.$type !== "CallExpr") {
    return false;
  }
  const fun = n.fun;
  return (
    isPkgDotName(fun, "wg", "Done") ||
    isIdent(fun, "panic") ||
    isPkgDotName(fun, "log", "Panic") ||
    isPkgDotName(fun, "log", "Panicf") ||
    isPkgDotName(fun, "log", "Panicln")
  );
}
