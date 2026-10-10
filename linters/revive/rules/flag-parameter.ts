import * as ast from "go/ast";
import { isIdent, seekNode } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "flag-parameter";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  for (const decl of file.ast.decls) {
    if (decl!.$type !== "FuncDecl" || (decl as ast.FuncDecl).body === null) {
      continue;
    }
    const fn = decl as ast.FuncDecl;
    const params = fn.type!.params!;
    const boolParams = new Set<string>();
    for (const param of params.list) {
      if (isIdent(param!.type, "bool")) {
        for (const id of param!.names) {
          boolParams.add(id!.name);
        }
      }
    }
    if (boolParams.size === 0) {
      continue;
    }
    // An if whose condition uses a parameter is reported, and not searched
    // further.
    ast.inspect(fn.body!, (n) => {
      if (n?.$type !== "IfStmt") {
        return true;
      }
      const use = seekNode((n as ast.IfStmt).cond, (c) => c.$type === "Ident" && boolParams.has((c as ast.Ident).name));
      if (use === null) {
        return true;
      }
      failures.push({ failure: `parameter '${(use as ast.Ident).name}' seems to be a control flag, avoid control coupling`, node: params, confidence: 1 });
      return false;
    });
  }
  return failures;
}
