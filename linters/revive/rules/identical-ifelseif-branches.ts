import type * as ast from "go/ast";
import { goFmt, seekNode, type Visitor, walk } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "identical-ifelseif-branches";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  const line = (node: ast.Node): number => file.toPosition(node.pos()).line;

  // The root visitor finds if...else if chains and checks each with a fresh chain.
  const root: Visitor = {
    visit(node) {
      if (node?.$type === "IfStmt" && (node as ast.IfStmt).else?.$type === "IfStmt") {
        checkChain(node as ast.IfStmt);
        return null;
      }
      return root;
    },
  };
  const walkBranch = (branch: ast.Stmt | null): void => {
    if (branch !== null) {
      walk(root, branch);
    }
  };

  const checkChain = (first: ast.IfStmt): void => {
    let branches: ast.Stmt[] | null = null;
    let hasComplexCondition = false;
    const reset = (): void => {
      branches = [];
      hasComplexCondition = false;
    };
    const addBranch = (branch: ast.Stmt | null): void => {
      if (branch === null) {
        return;
      }
      // As upstream, the first branch added clears a complex condition seen before it.
      if (branches === null) {
        reset();
      }
      branches!.push(branch);
    };
    const visitIf = (n: ast.IfStmt): void => {
      walkBranch(n.body);
      // Ifs with an initialisation are skipped to avoid false positives.
      if (n.init === null) {
        addBranch(n.body);
      }
      if (seekNode(n.cond, (c) => c.$type === "CallExpr") !== null) {
        hasComplexCondition = true;
      }
      if (n.else !== null) {
        if (n.else.$type === "IfStmt") {
          visitIf(n.else as ast.IfStmt);
        } else {
          addBranch(n.else);
          walkBranch(n.else);
        }
      }
      const list: ast.Stmt[] = branches ?? [];
      const hashes = new Map<string, number>();
      for (const branch of list.length < 2 ? [] : list) {
        const hash = goFmt(branch);
        const branchLine = line(branch);
        const match = hashes.get(hash);
        if (match !== undefined) {
          failures.push({
            failure: `"if...else if" chain with identical branches (lines ${match} and ${branchLine})`,
            node: list[0],
            confidence: hasComplexCondition ? 0.8 : 1,
          });
        }
        hashes.set(hash, branchLine);
      }
      reset();
    };
    visitIf(first);
  };

  for (const decl of file.ast.decls) {
    if (decl!.$type === "FuncDecl" && (decl as ast.FuncDecl).body !== null) {
      walk(root, (decl as ast.FuncDecl).body!);
    }
  }
  return failures;
}
