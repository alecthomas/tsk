import type * as ast from "go/ast";
import type * as token from "go/token";
import { type Visitor, walk } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "empty-block";

const message = "this block is empty, you can remove it";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  // Blocks are keyed by position, where revive keys them by pointer.
  const ignore = new Set<token.Pos>();
  const ignoreBody = (body: ast.BlockStmt | null): void => {
    if (body !== null) {
      ignore.add(body.pos());
    }
  };
  const visitor: Visitor = {
    visit(node) {
      switch (node?.$type) {
        case "FuncDecl":
          ignoreBody((node as ast.FuncDecl).body);
          return visitor;
        case "FuncLit":
          ignoreBody((node as ast.FuncLit).body);
          return visitor;
        case "SelectStmt":
          ignoreBody((node as ast.SelectStmt).body);
          return visitor;
        case "ForStmt": {
          const n = node as ast.ForStmt;
          if (n.body!.list.length === 0 && n.init === null && n.post === null && n.cond !== null && n.cond.$type === "CallExpr") {
            ignoreBody(n.body);
          }
          return visitor;
        }
        case "RangeStmt": {
          const n = node as ast.RangeStmt;
          if (n.body!.list.length === 0) {
            if (n.key === null && n.value === null) {
              // Bare for-range loops commonly drain channels.
              ignoreBody(n.body);
              return visitor;
            }
            failures.push({ failure: message, node: n, confidence: 0.9 });
            return null;
          }
          return visitor;
        }
        case "BlockStmt": {
          const n = node as ast.BlockStmt;
          if (!ignore.has(n.pos()) && n.list.length === 0) {
            failures.push({ failure: message, node: n, confidence: 1 });
          }
          return visitor;
        }
      }
      return visitor;
    },
  };
  walk(visitor, file.ast);
  return failures;
}
