import type * as ast from "go/ast";
import { goFmt, type Visitor, walk } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "identical-ifelseif-conditions";

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
    // Condition hashes to the lines of their ifs.
    let conditions = new Map<string, number>();
    const visitIf = (n: ast.IfStmt): void => {
      walkBranch(n.body);
      // Ifs with an initialisation are skipped to avoid false positives.
      if (n.init === null && n.cond !== null) {
        const currentLine = line(n);
        const hash = goFmt(n.cond);
        const identicalLine = conditions.get(hash);
        if (identicalLine !== undefined) {
          failures.push({
            failure: `"if...else if" chain with identical conditions (lines ${identicalLine} and ${currentLine})`,
            node: n,
            confidence: 1,
          });
        } else {
          conditions.set(hash, currentLine);
        }
      }
      if (n.else !== null) {
        if (n.else.$type === "IfStmt") {
          visitIf(n.else as ast.IfStmt);
        } else {
          walkBranch(n.else);
        }
      }
      conditions = new Map();
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
