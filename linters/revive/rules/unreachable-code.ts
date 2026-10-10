import type * as ast from "go/ast";
import * as token from "go/token";
import { walk } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "unreachable-code";

export function create(): Rule {
  return { name, apply };
}

const testingFunctions = new Set(["Fatal", "Fatalf", "FailNow"]);

// Upstream matches receivers by name, so t, b, and f stand for testing types.
const branchingFunctions = new Map<string, Set<string>>([
  ["os", new Set(["Exit"])],
  ["log", new Set(["Fatal", "Fatalf", "Fatalln", "Panic", "Panicf", "Panicln"])],
  ["t", testingFunctions],
  ["b", testingFunctions],
  ["f", testingFunctions],
]);

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  walk(
    {
      visit(node) {
        if (node !== null && node.$type === "BlockStmt") {
          const unreachable = firstUnreachable((node as ast.BlockStmt).list);
          if (unreachable !== undefined) {
            failures.push({ failure: "unreachable code after this statement", confidence: 1, node: unreachable });
          }
        }
        return this;
      },
    },
    file.ast,
  );
  return failures;
}

// The first statement that unreachable code follows, if any.
function firstUnreachable(list: readonly (ast.Stmt | null)[]): ast.Stmt | undefined {
  for (let i = 0; i < list.length - 1; i++) {
    const stmt = list[i]!;
    const next = list[i + 1]!;
    if (next.$type === "LabeledStmt") {
      continue;
    }
    switch (stmt.$type) {
      case "ReturnStmt":
        return stmt;
      case "BranchStmt":
        if ((stmt as ast.BranchStmt).tok !== token.FALLTHROUGH) {
          return stmt;
        }
        break;
      case "ExprStmt":
        // A return may follow to satisfy the function's signature.
        if (isBranchingCall(stmt as ast.ExprStmt) && next.$type !== "ReturnStmt") {
          return stmt;
        }
        break;
    }
  }
  return undefined;
}

function isBranchingCall(stmt: ast.ExprStmt): boolean {
  if (stmt.x!.$type !== "CallExpr") {
    return false;
  }
  const fun = (stmt.x as ast.CallExpr).fun!;
  if (fun.$type !== "SelectorExpr") {
    return false;
  }
  const sel = fun as ast.SelectorExpr;
  if (sel.x!.$type !== "Ident") {
    return false;
  }
  return branchingFunctions.get((sel.x as ast.Ident).name)?.has(sel.sel!.name) ?? false;
}
