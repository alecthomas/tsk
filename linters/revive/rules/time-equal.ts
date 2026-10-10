import type * as types from "go/types";
import * as token from "go/token";
import { goFmt, walk, type Visitor } from "../astutils";
import type { Failure, File, Rule } from "../lint";

export const name = "time-equal";

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  // Revive skips packages that fail to type-check.
  if (file.pkg.pass.typeErrors.length > 0) {
    return [];
  }
  const failures: Failure[] = [];
  const visitor: Visitor = {
    visit(node) {
      if (node === null || node.$type !== "BinaryExpr" || (node.op !== token.EQL && node.op !== token.NEQ)) {
        return visitor;
      }
      if (!isTime(file.pkg.typeOf(node.x!)) || !isTime(file.pkg.typeOf(node.y!))) {
        return visitor;
      }
      const negate = node.op === token.NEQ ? "!" : "";
      const op = node.op === token.NEQ ? `"!="` : `"=="`;
      failures.push({ failure: `use ${negate}${goFmt(node.x!)}.Equal(${goFmt(node.y!)}) instead of ${op} operator`, node, confidence: 1 });
      return visitor;
    },
  };
  walk(visitor, file.ast);
  return failures;
}

function isTime(t: types.Type | null): boolean {
  if (t === null || t.$type !== "Named") {
    return false;
  }
  const obj = t.obj();
  return obj !== null && obj.pkg() !== null && obj.pkg()!.path() === "time" && obj.name() === "Time";
}
