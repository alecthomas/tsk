import type * as ast from "go/ast";
import * as token from "go/token";
import { pickNodes, seekNode } from "../astutils";
import type { Failure, File, Package, Rule } from "../lint";

export const name = "modifies-value-receiver";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  for (const decl of file.ast.decls) {
    if (decl?.$type !== "FuncDecl" || decl.recv === null) {
      continue;
    }
    const receiver = decl.recv.list[0]!;
    if (mustSkip(receiver, file.pkg)) {
      continue;
    }
    const receiverName = receiver.names[0]!.name;
    const assignments = receiverModifications(receiverName, decl.body);
    // A method returning its modified receiver seems legit (revive issue #1066).
    if (assignments.length === 0 || returnsReceiver(receiverName, decl.body)) {
      continue;
    }
    for (const node of assignments) {
      failures.push({ failure: "suspicious assignment to a by-value method receiver", node, confidence: 1 });
    }
  }
  return failures;
}

function mustSkip(receiver: ast.Field, pkg: Package): boolean {
  if (receiver.type!.$type === "StarExpr" || receiver.names.length < 1 || receiver.names[0]!.name === "_") {
    return true;
  }
  // Maps and slices share their contents with the caller.
  const name = pkg.typeOf(receiver.type!)?.underlying()?.string() ?? "";
  return name.startsWith("[]") || name.startsWith("map[");
}

function nameOf(e: ast.Expr | null): string {
  return e !== null && e.$type === "Ident" ? e.name : "";
}

function returnsReceiver(receiverName: string, body: ast.BlockStmt | null): boolean {
  const finder = (n: ast.Node): boolean =>
    n.$type === "ReturnStmt" &&
    n.results.some((e) => {
      switch (e!.$type) {
        case "SelectorExpr":
          return nameOf(e.x) === receiverName;
        case "Ident":
          return e.name === receiverName;
        case "UnaryExpr":
          return e.op === token.AND && nameOf(e.x) === receiverName;
      }
      return false;
    });
  return seekNode(body, finder) !== null;
}

function receiverModifications(receiverName: string, body: ast.BlockStmt | null): ast.Node[] {
  const finder = (n: ast.Node): boolean => {
    switch (n.$type) {
      case "IncDecStmt":
        return n.x!.$type === "SelectorExpr" && nameOf(n.x.x) === receiverName;
      case "AssignStmt":
        return n.lhs.some((e) => {
          switch (e!.$type) {
            case "SelectorExpr":
              return nameOf(e.x) === receiverName;
            case "Ident":
              return e.name === receiverName;
          }
          return false;
        });
    }
    return false;
  };
  return pickNodes(body, finder);
}
