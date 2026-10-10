import * as ast from "go/ast";
import * as token from "go/token";
import type * as types from "go/types";
import type { Failure, File, Rule } from "../lint";

export const name = "epoch-naming";

const epochUnits = new Map([
  ["Unix", ["Sec", "Second", "Seconds"]],
  ["UnixMilli", ["Milli", "Ms"]],
  ["UnixMicro", ["Micro", "Microsecond", "Microseconds", "Us"]],
  ["UnixNano", ["Nano", "Ns"]],
]);

export function create(): Rule {
  return { name, apply };
}

function apply(file: File): Failure[] {
  const failures: Failure[] = [];
  const check = (id: ast.Ident, value: ast.Expr): void => {
    if (value.$type !== "CallExpr") {
      return;
    }
    const fun = (value as ast.CallExpr).fun!;
    if (fun.$type !== "SelectorExpr") {
      return;
    }
    const selector = fun as ast.SelectorExpr;
    if (!isTime(file.pkg.typeOf(selector.x!))) {
      return;
    }
    const suffixes = epochUnits.get(selector.sel!.name);
    if (suffixes === undefined) {
      return;
    }
    const lower = id.name.toLowerCase();
    if (!suffixes.some((suffix) => lower.endsWith(suffix.toLowerCase()))) {
      failures.push({ failure: `var ${id.name} should have one of these suffixes: ${suffixes.join(", ")}`, confidence: 0.9, node: id });
    }
  };
  ast.inspect(file.ast, (node) => {
    if (node === null) {
      return true;
    }
    if (node.$type === "ValueSpec") {
      const v = node as ast.ValueSpec;
      v.names.slice(0, v.values.length).forEach((id, i) => check(id!, v.values[i]!));
    } else if (node.$type === "AssignStmt") {
      const v = node as ast.AssignStmt;
      if (v.tok !== token.DEFINE && v.tok !== token.ASSIGN) {
        return true;
      }
      v.lhs.slice(0, v.rhs.length).forEach((lhs, i) => {
        if (lhs!.$type === "Ident" && (lhs as ast.Ident).name !== "_") {
          check(lhs as ast.Ident, v.rhs[i]!);
        }
      });
    }
    return true;
  });
  return failures;
}

function isTime(typ: types.Type | null): boolean {
  if (typ === null || typ.$type !== "Named") {
    return false;
  }
  const obj = (typ as types.Named).obj();
  return obj !== null && obj.pkg() !== null && obj.pkg()!.path() === "time" && obj.name() === "Time";
}
