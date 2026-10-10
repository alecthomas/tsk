import type * as ast from "go/ast";
import * as token from "go/token";
import { isIdent, walk, type Visitor } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "inefficient-map-lookup";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  // Revive reports an internal failure instead when the package does not
  // type-check; this port reports nothing.
  if (file.pkg.pass.typeErrors.length > 0) {
    return [];
  }
  const failures: Failure[] = [];
  const visitor: Visitor = {
    visit(node) {
      if (node !== null && node.$type === "BlockStmt") {
        for (const stmt of node.list) {
          if (stmt!.$type === "RangeStmt" && isRangeOverMapKey(file, stmt) && isKeyLookup((stmt.key as ast.Ident).name, stmt.body!)) {
            failures.push({ failure: "inefficient lookup of map key", node: stmt, confidence: 1 });
          }
        }
      }
      return visitor;
    },
  };
  for (const decl of file.ast.decls) {
    if (decl?.$type === "FuncDecl" && decl.body !== null) {
      walk(visitor, decl.body);
    }
  }
  return failures;
}

// isKeyLookup reports whether the body is { if key == x { ... } } or starts
// with if key != x { continue ... }.
function isKeyLookup(keyName: string, block: ast.BlockStmt): boolean {
  const first = block.list[0];
  if (first === undefined || first!.$type !== "IfStmt") {
    return false;
  }
  const cond = first.cond!;
  if (cond.$type !== "BinaryExpr" || !isIdent(cond.x, keyName)) {
    return false;
  }
  switch (cond.op) {
    case token.EQL:
      return block.list.length === 1;
    case token.NEQ: {
      const stmt = first.body!.list[0];
      return stmt !== undefined && stmt!.$type === "BranchStmt" && stmt.tok === token.CONTINUE;
    }
  }
  return false;
}

// isRangeOverMapKey reports whether the statement ranges over only the keys of a map.
function isRangeOverMapKey(file: File, stmt: ast.RangeStmt): boolean {
  // Revive panics on a key that is not an identifier.
  if (stmt.key === null || stmt.key.$type !== "Ident" || (stmt.value !== null && !isIdent(stmt.value, "_"))) {
    return false;
  }
  return file.pkg.typeOf(stmt.x!)?.string().startsWith("map[") ?? false;
}
