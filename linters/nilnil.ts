import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

type CheckedType = "chan" | "func" | "iface" | "map" | "ptr" | "uintptr" | "unsafeptr";

interface Config {
  /** Value types to check: chan, func, iface, map, ptr, uintptr, and unsafeptr. */
  checkedTypes: CheckedType[];
  /** Also report returning both a non-nil error and a valid value. */
  detectOpposite: boolean;
  /** Check only the first two results, the second being the error. */
  onlyTwo: boolean;
}

export default defineAnalyzer<Config>({
  name: "nilnil",
  doc: "Checks that there is no simultaneous return of `nil` error and an invalid value.",
  requires: [inspect],
  config: {
    checkedTypes: ["chan", "func", "iface", "map", "ptr", "uintptr", "unsafeptr"],
    detectOpposite: false,
    onlyTwo: true,
  },
  run(pass) {
    const errorType = types.Universe!.lookup("error")!.type()!.underlying() as types.Interface;
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.ReturnStmt)) {
      const stmt = cursor.node() as ast.ReturnStmt;
      const fn = cursor.enclosing(ast.FuncDecl, ast.FuncLit).toArray()[0]?.node() as ast.FuncDecl | ast.FuncLit | undefined;
      if (fn !== undefined) {
        check(pass, errorType, stmt, fn.type!);
      }
    }
  },
});

function check(pass: Pass<Config>, errorType: types.Interface, stmt: ast.ReturnStmt, fnType: ast.FuncType): void {
  // Results are matched to fields, so (a, b int, err error) is skipped.
  const fields = fnType.results?.list ?? [];
  if (stmt.results.length < 2 || fields.length !== stmt.results.length) {
    return;
  }
  const errIdx = pass.config.onlyTwo ? 1 : fields.length - 1;
  const errType = pass.typesInfo.typeOf(fields[errIdx]!.type!);
  if (errType?.underlying()?.$type !== "Interface" || !types.implements_(errType, errorType)) {
    return;
  }
  const errIsNil = isNil(pass, stmt.results[errIdx]!);
  for (let i = 0; i < errIdx; i++) {
    const zero = zeroValue(pass, pass.typesInfo.typeOf(fields[i]!.type!));
    if (zero === null) {
      continue;
    }
    const value = stmt.results[i]!;
    const valueIsZero = zero === "nil" ? isNil(pass, value) : isZero(value);
    if (valueIsZero && errIsNil) {
      pass.report({ pos: stmt.pos(), message: "return both a `nil` error and an invalid value: use a sentinel error instead" });
      return;
    }
    if (pass.config.detectOpposite && !valueIsZero && !errIsNil) {
      pass.report({ pos: stmt.pos(), message: "return both a non-nil error and a valid value: use separate returns instead" });
      return;
    }
  }
}

// zeroValue returns how a checked type's invalid zero value is written, or
// null for a type not checked.
function zeroValue(pass: Pass<Config>, t: types.Type | null): "nil" | "zero" | null {
  const u = types.unalias(t);
  const checked = (name: CheckedType) => pass.config.checkedTypes.includes(name);
  switch (u?.$type) {
    case "Pointer":
      return checked("ptr") ? "nil" : null;
    case "Signature":
      return checked("func") ? "nil" : null;
    case "Interface":
      return checked("iface") ? "nil" : null;
    case "Map":
      return checked("map") ? "nil" : null;
    case "Chan":
      return checked("chan") ? "nil" : null;
    case "Basic":
      if (u.kind() === types.Uintptr) {
        return checked("uintptr") ? "zero" : null;
      }
      if (u.kind() === types.UnsafePointer) {
        return checked("unsafeptr") ? "nil" : null;
      }
      return null;
    case "Named":
      return zeroValue(pass, u.underlying());
    default:
      return null;
  }
}

function isNil(pass: Pass<Config>, expr: ast.Expr): boolean {
  return expr.$type === "Ident" && pass.typesInfo.objectOf(expr)?.$type === "Nil";
}

// isZero matches an integer literal of zero in any base, such as 0x0.
function isZero(expr: ast.Expr): boolean {
  return expr.$type === "BasicLit" && expr.kind === token.INT && /^(0[xXbBoO]0+|0+)$/.test(expr.value.replace(/_/g, ""));
}
