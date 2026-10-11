import { defineAnalyzer } from "tsk";
import { runRule } from "../lint";
import type * as ast from "go/ast";
import { goFmt, type Visitor, walk } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "identical-branches";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  const visitor: Visitor = {
    visit(node) {
      if (node?.$type !== "IfStmt") {
        return visitor;
      }
      const ifStmt = node as ast.IfStmt;
      // Only single if...else statements, not if...else if chains.
      if (ifStmt.else === null || ifStmt.else.$type !== "BlockStmt") {
        return visitor;
      }
      const elseBranch = ifStmt.else as ast.BlockStmt;
      const body = ifStmt.body!;
      if (body.list.length === elseBranch.list.length && goFmt(body) === goFmt(elseBranch)) {
        failures.push({ failure: "both branches of the if are identical", node: ifStmt, confidence: 1 });
      }
      walk(visitor, body);
      walk(visitor, elseBranch);
      return null;
    },
  };
  for (const decl of file.ast.decls) {
    if (decl!.$type === "FuncDecl" && (decl as ast.FuncDecl).body !== null) {
      walk(visitor, (decl as ast.FuncDecl).body!);
    }
  }
  return failures;
}

export default defineAnalyzer({
  name: "identical_branches",
  doc: "Spots if-then-else statements with identical `then` and `else` branches",
  url: "https://github.com/mgechev/revive/blob/v1.17.0/RULES_DESCRIPTIONS.md#identical-branches",
  group: "revive",
  enabledByDefault: false,
  runDespiteErrors: true,
  run(pass) {
    runRule(pass, create());
  },
});
