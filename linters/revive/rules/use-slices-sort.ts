import type * as ast from "go/ast";
import { isIdent, walk, type Visitor } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "use-slices-sort";

// Sort functions and their replacements in package slices.
const replacements = new Map<string, string>([
  ["Float64s", "Sort"],
  ["Ints", "Sort"],
  ["Strings", "Sort"],
  ["Slice", "SortFunc"],
  ["Sort", "SortFunc"],
  ["SliceStable", "SortStableFunc"],
  ["Stable", "SortStableFunc"],
  ["Float64sAreSorted", "IsSorted"],
  ["IntsAreSorted", "IsSorted"],
  ["StringsAreSorted", "IsSorted"],
  ["IsSorted", "IsSortedFunc"],
  ["SliceIsSorted", "IsSortedFunc"],
]);

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  // Package slices arrived in Go 1.21.
  if (!file.pkg.isAtLeastGoVersion("1.21")) {
    return [];
  }
  const failures: Failure[] = [];
  const visitor: Visitor = {
    visit(node) {
      if (node === null || node.$type !== "CallExpr" || node.fun!.$type !== "SelectorExpr") {
        return visitor;
      }
      const sel = node.fun as ast.SelectorExpr;
      const replacement = replacements.get(sel.sel!.name);
      if (!isIdent(sel.x, "sort") || replacement === undefined) {
        return visitor;
      }
      failures.push({ failure: `replace sort.${sel.sel!.name} by slices.${replacement}`, node, confidence: 1 });
      return null;
    },
  };
  walk(visitor, file.ast);
  return failures;
}
