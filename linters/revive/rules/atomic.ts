import type * as ast from "go/ast";
import * as token from "go/token";
import { goFmt, walk, type Visitor } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "atomic";

const addFunctions = new Set(["AddInt32", "AddInt64", "AddUint32", "AddUint64", "AddUintptr"]);

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  const info = file.pkg.typesInfo;
  // Revive checks the package only when another rule has type-checked it, so
  // alone it also flags methods named like atomic's; this port always checks.
  const visitor: Visitor = {
    visit(node) {
      if (node === null || node.$type !== "AssignStmt") {
        return visitor;
      }
      const n = node as ast.AssignStmt;
      if (n.lhs.length !== n.rhs.length || (n.lhs.length === 1 && n.tok === token.DEFINE)) {
        return null;
      }
      n.rhs.forEach((right, i) => {
        if (right!.$type !== "CallExpr") {
          return;
        }
        const call = right as ast.CallExpr;
        if (call.fun!.$type !== "SelectorExpr") {
          return;
        }
        const sel = call.fun as ast.SelectorExpr;
        const pkgName = sel.x!.$type === "Ident" ? info.uses.get(sel.x as ast.Ident) : undefined;
        if (pkgName?.$type !== "PkgName" || pkgName.imported()!.path() !== "sync/atomic") {
          return;
        }
        if (!addFunctions.has(sel.sel!.name) || call.args.length !== 2) {
          return;
        }
        const left = n.lhs[i]!;
        const arg = call.args[0]!;
        let broken = false;
        if (arg.$type === "UnaryExpr" && (arg as ast.UnaryExpr).op === token.AND) {
          broken = goFmt(left) === goFmt((arg as ast.UnaryExpr).x!);
        } else if (left.$type === "StarExpr") {
          broken = goFmt((left as ast.StarExpr).x!) === goFmt(arg);
        }
        if (broken) {
          failures.push({ failure: "direct assignment to atomic value", node: n, confidence: 1 });
        }
      });
      return visitor;
    },
  };
  walk(visitor, file.ast);
  return failures;
}
