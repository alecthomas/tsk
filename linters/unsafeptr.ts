// Port of golang.org/x/tools/go/analysis/passes/unsafeptr at v0.50.0.
import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";
import { isTypeNamed } from "./internal/typesinternal";

export default defineAnalyzer({
  name: "unsafeptr",
  doc: `check for invalid conversions of uintptr to unsafe.Pointer

The unsafeptr analyzer reports likely incorrect uses of unsafe.Pointer
to convert integers to pointers. A conversion from uintptr to
unsafe.Pointer is invalid if it implies that there is a uintptr-typed
word in memory that holds a pointer value, because that word will be
invisible to stack copying and to the garbage collector.`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/unsafeptr",
  requires: [inspect],
  run(pass) {
    const info = pass.typesInfo;
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr, ast.StarExpr, ast.UnaryExpr)) {
      const x = cursor.node();
      if (x?.$type === "CallExpr") {
        if (
          x.args.length === 1 &&
          hasBasicType(info, x.fun, types.UnsafePointer) &&
          hasBasicType(info, x.args[0], types.Uintptr) &&
          !isSafeUintptr(info, x.args[0]!)
        ) {
          pass.report({ pos: x.pos(), end: x.end(), message: "possible misuse of unsafe.Pointer" });
        }
      } else if (x?.$type === "StarExpr" || (x?.$type === "UnaryExpr" && x.op === token.AND)) {
        const t = typeOf(info, x.$type === "StarExpr" ? x : x.x);
        if (isReflectHeader(t)) {
          pass.report({ pos: x.pos(), end: x.end(), message: `possible misuse of ${t!.string()}` });
        }
      }
    }
  },
});

function typeOf(info: types.Info, x: ast.Expr | null): types.Type | null {
  return x === null ? null : (info.types.get(x)?.type ?? null);
}

// isSafeUintptr reports whether x, known to be a uintptr, is safe to convert
// to unsafe.Pointer, following https://golang.org/pkg/unsafe/#Pointer.
function isSafeUintptr(info: types.Info, x: ast.Expr): boolean {
  const e = ast.unparen(x);
  if (e?.$type === "SelectorExpr") {
    // "(6) Conversion of a reflect.SliceHeader or reflect.StringHeader Data
    // field to or from Pointer." Only *Header points at a real slice or string.
    if (e.sel!.name === "Data") {
      const pt = types.unalias(typeOf(info, e.x));
      if (pt?.$type === "Pointer" && isReflectHeader(pt.elem())) {
        return true;
      }
    }
  } else if (e?.$type === "CallExpr") {
    // "(5) Conversion of the result of reflect.Value.Pointer or
    // reflect.Value.UnsafeAddr from uintptr to Pointer."
    const sel = e.fun;
    if (e.args.length === 0 && sel?.$type === "SelectorExpr") {
      const name = sel.sel!.name;
      if ((name === "Pointer" || name === "UnsafeAddr") && isTypeNamed(typeOf(info, sel.x), "reflect", "Value")) {
        return true;
      }
    }
  }
  // "(3) Conversion of a Pointer to a uintptr and back, with arithmetic."
  return isSafeArith(info, x);
}

// isSafeArith reports whether x is pointer arithmetic that is safe to
// convert to unsafe.Pointer.
function isSafeArith(info: types.Info, x: ast.Expr | null): boolean {
  const e = ast.unparen(x);
  if (e?.$type === "CallExpr") {
    // Base case: initial conversion from unsafe.Pointer to uintptr.
    return e.args.length === 1 && hasBasicType(info, e.fun, types.Uintptr) && hasBasicType(info, e.args[0], types.UnsafePointer);
  }
  if (e?.$type === "BinaryExpr" && (e.op === token.ADD || e.op === token.SUB || e.op === token.AND_NOT)) {
    return isSafeArith(info, e.x) && !isSafeArith(info, e.y);
  }
  return false;
}

// hasBasicType reports whether x's type is a types.Basic with the given kind.
function hasBasicType(info: types.Info, x: ast.Expr | null, kind: types.BasicKind): boolean {
  const t = typeOf(info, x)?.underlying();
  return t?.$type === "Basic" && t.kind() === kind;
}

// isReflectHeader reports whether t is reflect.SliceHeader or reflect.StringHeader.
function isReflectHeader(t: types.Type | null): boolean {
  return isTypeNamed(t, "reflect", "SliceHeader", "StringHeader");
}
