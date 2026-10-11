// Port of golang.org/x/tools/go/analysis/passes/cgocall at v0.50.0.
import * as ast from "go/ast";
import * as parser from "go/parser";
import * as token from "go/token";
import * as types from "go/types";
import * as os from "os";
import { defineAnalyzer, formatNode, type Pass } from "tsk";
import { imports } from "./internal/typesinternal";

type TypeOf = (e: ast.Expr) => types.Type | null;

export default defineAnalyzer({
  name: "cgocall",
  doc: `detect some violations of the cgo pointer passing rules

Check for invalid cgo pointer passing.
This looks for code that uses cgo to call C code passing values
whose types are almost always invalid according to the cgo pointer
sharing rules.
Specifically, it warns about attempts to pass a Go chan, map, func,
or slice to C, either directly, or via a pointer, array, or struct.`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/cgocall",
  runDespiteErrors: true,
  run(pass) {
    if (!imports(pass.pkg, "runtime/cgo")) {
      return;
    }
    for (const cooked of pass.files) {
      // For a cgo-generated file, the position honours //line directives
      // and names the raw cgo source file.
      const filename = pass.fset.position(cooked!.pos()).filename;
      let raw: ast.File;
      try {
        raw = parser.parseFile(pass.fset, filename, os.readFile(filename), parser.SkipObjectResolution)!;
      } catch (err) {
        throw new Error(`can't parse raw cgo file: ${(err as Error).message}`);
      }
      if (!raw.imports.some((spec) => spec!.path!.value === '"C"')) {
        continue;
      }
      checkCgo(pass, raw, rawTypes(pass, cooked!));
    }
  },
});

// Upstream type-checks raw files, which the bindings cannot; instead a raw expression takes the type of
// its cooked copy: the same node kind, at the same //line-adjusted position, printing identically.
function rawTypes(pass: Pass<unknown>, cooked: ast.File): TypeOf {
  const index = new Map<string, ast.Expr[]>();
  const key = (e: ast.Expr) => {
    const posn = pass.fset.position(e.pos());
    return `${posn.line}:${posn.column}:${e.$type}`;
  };
  for (const n of ast.preorder(cooked)) {
    const e = n as ast.Expr;
    if (!pass.typesInfo.types.has(e)) {
      continue;
    }
    const k = key(e);
    index.set(k, [...(index.get(k) ?? []), e]);
  }
  const copied = (e: ast.Expr) => {
    const text = formatNode(e);
    const match = index.get(key(e))?.find((c) => formatNode(c) === text);
    return match === undefined ? null : (pass.typesInfo.types.get(match)?.type ?? null);
  };
  const typeOf: TypeOf = (e) => copied(e) ?? derived(e);
  // cgo rewrites &x[i] to &(*tmp)[i] after taking &x, so these derive their type from x.
  const derived = (e: ast.Expr): types.Type | null => {
    switch (e.$type) {
      case "ParenExpr":
        return typeOf(e.x!);
      case "UnaryExpr": {
        const x = e.op === token.AND ? typeOf(e.x!) : null;
        return x === null ? null : types.newPointer(x);
      }
      case "IndexExpr": {
        let x = typeOf(e.x!)?.underlying() ?? null;
        if (x?.$type === "Pointer") {
          x = x.elem()?.underlying() ?? null;
          if (x?.$type !== "Array") {
            return null;
          }
        }
        return x?.$type === "Array" || x?.$type === "Slice" || x?.$type === "Map" ? x.elem() : null;
      }
    }
    return null;
  };
  return typeOf;
}

function checkCgo(pass: Pass<unknown>, f: ast.File, typeOf: TypeOf): void {
  for (const n of ast.preorder(f)) {
    if (n?.$type !== "CallExpr") {
      continue;
    }
    // Is this a C.f() call?
    const sel = ast.unparen(n.fun);
    if (sel?.$type !== "SelectorExpr" || sel.x?.$type !== "Ident" || sel.x.name !== "C") {
      continue;
    }
    // A call to C.CBytes passes a pointer but is always safe.
    if (sel.sel!.name === "CBytes") {
      continue;
    }
    for (let arg of n.args) {
      if (!typeOKForCgoCall(cgoBaseType(typeOf, arg!), new Set())) {
        pass.report({ pos: arg!.pos(), message: "possibly passing Go type with embedded pointer to C" });
        break;
      }
      // Check for passing the address of a bad type.
      if (arg!.$type === "CallExpr" && arg.args.length === 1 && isUnsafePointer(typeOf, arg.fun!)) {
        arg = arg.args[0];
      }
      if (arg!.$type === "UnaryExpr" && arg.op === token.AND) {
        if (!typeOKForCgoCall(cgoBaseType(typeOf, arg.x!), new Set())) {
          pass.report({ pos: arg.pos(), message: "possibly passing Go type with embedded pointer to C" });
          break;
        }
      }
    }
  }
}

// cgoBaseType looks through conversions involving unsafe.Pointer to find the
// real type: unsafe.Pointer(x) and *(*unsafe.Pointer)(unsafe.Pointer(&x)) give x.
function cgoBaseType(typeOf: TypeOf, arg: ast.Expr): types.Type | null {
  if (arg.$type === "CallExpr") {
    if (arg.args.length === 1 && isUnsafePointer(typeOf, arg.fun!)) {
      return cgoBaseType(typeOf, arg.args[0]!);
    }
  } else if (arg.$type === "StarExpr") {
    const base = starBase(typeOf, arg);
    if (base !== null) {
      return cgoBaseType(typeOf, base);
    }
  }
  return typeOf(arg);
}

// starBase returns v when arg is *(*unsafe.Pointer)(unsafe.Pointer(&v)).
function starBase(typeOf: TypeOf, arg: ast.StarExpr): ast.Expr | null {
  const call = arg.x;
  if (call?.$type !== "CallExpr" || call.args.length !== 1) {
    return null;
  }
  const ptr = typeOf(call.fun!)?.underlying();
  if (ptr?.$type !== "Pointer") {
    return null;
  }
  const elem = ptr.elem()?.underlying();
  if (elem?.$type !== "Basic" || elem.kind() !== types.UnsafePointer) {
    return null;
  }
  const inner = call.args[0];
  if (inner?.$type !== "CallExpr" || inner.args.length !== 1 || !isUnsafePointer(typeOf, inner.fun!)) {
    return null;
  }
  const u = inner.args[0];
  return u?.$type === "UnaryExpr" && u.op === token.AND ? u.x : null;
}

// typeOKForCgoCall reports whether a value of type t is OK to pass to C:
// Go types with embedded pointers are not. seen stops recursive types.
function typeOKForCgoCall(t: types.Type | null, seen: Set<types.Type>): boolean {
  if (t === null || seen.has(t)) {
    return true;
  }
  seen.add(t);
  const u = t.underlying();
  switch (u?.$type) {
    case "Chan":
    case "Map":
    case "Signature":
    case "Slice":
      return false;
    case "Pointer":
    case "Array":
      return typeOKForCgoCall(u.elem(), seen);
    case "Struct":
      for (const field of u.fields()) {
        if (!typeOKForCgoCall(field!.type(), seen)) {
          return false;
        }
      }
  }
  return true;
}

function isUnsafePointer(typeOf: TypeOf, e: ast.Expr): boolean {
  const t = typeOf(e)?.underlying();
  return t?.$type === "Basic" && t.kind() === types.UnsafePointer;
}
