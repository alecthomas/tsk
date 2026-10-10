import type * as ast from "go/ast";
import { pickNodes, walk, type Visitor } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "datarace";

// Identifiers are told apart by their ast.Object, as revive does, so a missing
// object (null) is a key like any other.
type NodeUID = ast.Object | null;

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const go122 = file.pkg.isAtLeastGoVersion("1.22");
  const failures: Failure[] = [];
  for (const decl of file.ast.decls) {
    if (decl?.$type !== "FuncDecl" || decl.body === null) {
      continue;
    }
    const returnIDs = new Set<NodeUID>();
    for (const field of decl.type!.results?.list ?? []) {
      for (const id of field!.names) {
        returnIDs.add(id!.obj);
      }
    }
    walk(raceVisitor(failures, returnIDs, new Set(), go122), decl.body);
  }
  return failures;
}

function raceVisitor(failures: Failure[], returnIDs: Set<NodeUID>, rangeIDs: Set<NodeUID>, go122: boolean): Visitor {
  const visitor: Visitor = {
    visit(node) {
      if (node === null) {
        return visitor;
      }
      switch (node.$type) {
        case "RangeStmt": {
          if (node.body === null) {
            return null;
          }
          const ids = [node.key, node.value].filter((e): e is ast.Ident => e !== null && e.$type === "Ident");
          for (const id of ids) {
            rangeIDs.add(id.obj);
          }
          walk(visitor, node.body);
          for (const id of ids) {
            rangeIDs.delete(id.obj);
          }
          return null;
        }
        case "GoStmt": {
          const fun = node.call!.fun!;
          if (fun.$type !== "FuncLit") {
            return null;
          }
          for (const n of pickNodes(fun.body, (n) => n.$type === "Ident")) {
            const id = n as ast.Ident;
            if (rangeIDs.has(id.obj) && !go122) {
              failures.push({ failure: `datarace: range value ${id.name} is captured (by-reference) in goroutine`, node: id, confidence: 1 });
            } else if (returnIDs.has(id.obj)) {
              failures.push({ failure: `potential datarace: return value ${id.name} is captured (by-reference) in goroutine`, node: id, confidence: 0.8 });
            }
          }
          return null;
        }
      }
      return visitor;
    },
  };
  return visitor;
}
