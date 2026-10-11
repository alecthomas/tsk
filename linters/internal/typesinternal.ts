// Helpers from golang.org/x/tools/internal/typesinternal, which many of the
// ported vet analyzers share.
import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";

/** Reports whether obj is declared at package level. */
export function isPackageLevel(obj: types.Object): boolean {
  const pkg = obj.pkg();
  return pkg !== null && obj.parent() === pkg.scope();
}

/**
 * Reports whether t is, or is an alias for, a package-level defined type in
 * the package pkgPath with one of the given names.
 */
export function isTypeNamed(t: types.Type | null, pkgPath: string, ...names: string[]): boolean {
  const named = types.unalias(t);
  if (named?.$type !== "Named") {
    return false;
  }
  const tname = named.obj();
  return tname !== null && isPackageLevel(tname) && tname.pkg()!.path() === pkgPath && names.includes(tname.name());
}

/** Reports whether t is, or is an alias for, a pointer to a type isTypeNamed matches. */
export function isPointerToNamed(t: types.Type | null, pkgPath: string, ...names: string[]): boolean {
  const r = unpointer(t);
  return r !== t && isTypeNamed(r, pkgPath, ...names);
}

/** Reports whether obj is a package-level function in pkgPath with one of the given names. */
export function isFunctionNamed(obj: types.Object | null, pkgPath: string, ...names: string[]): boolean {
  return (
    obj?.$type === "Func" &&
    isPackageLevel(obj) &&
    obj.pkg()!.path() === pkgPath &&
    obj.signature()!.recv() === null &&
    names.includes(obj.name())
  );
}

/**
 * Reports whether obj is a method, with one of the given names, of the
 * package-level type typeName in pkgPath.
 */
export function isMethodNamed(obj: types.Object | null, pkgPath: string, typeName: string, ...names: string[]): boolean {
  if (obj?.$type !== "Func") {
    return false;
  }
  const recv = obj.signature()!.recv();
  if (recv === null) {
    return false;
  }
  const { named } = receiverNamed(recv);
  return named !== null && isTypeNamed(named, pkgPath, typeName) && names.includes(obj.name());
}

/** Returns a receiver's named type, and whether the receiver is a pointer to it. */
export function receiverNamed(recv: types.Var): { isPtr: boolean; named: types.Named | null } {
  let t = recv.type();
  let isPtr = false;
  const ptr = types.unalias(t);
  if (ptr?.$type === "Pointer") {
    isPtr = true;
    t = ptr.elem();
  }
  const named = types.unalias(t);
  return { isPtr, named: named?.$type === "Named" ? named : null };
}

/** Returns T given *T or an alias for it, and t itself for any other type. */
export function unpointer(t: types.Type | null): types.Type | null {
  const ptr = types.unalias(t);
  return ptr?.$type === "Pointer" ? ptr.elem() : t;
}

/** Returns the identifier for the object e uses, looking through parentheses and instantiation. */
export function usedIdent(info: types.Info, e: ast.Expr): ast.Ident | null {
  let x = ast.unparen(e);
  if (x?.$type === "IndexExpr") {
    if (info.types.get(x.index!)?.isType()) {
      x = x.x;
    }
  } else if (x?.$type === "IndexListExpr") {
    x = x.x;
  }
  x = ast.unparen(x);
  if (x?.$type === "Ident") {
    return x;
  }
  return x?.$type === "SelectorExpr" ? x.sel : null;
}

/** Reports whether evaluating expr has no side effects. */
export function noEffects(info: types.Info, expr: ast.Expr): boolean {
  let result = true;
  ast.inspect(expr, (n) => {
    switch (n?.$type) {
      case undefined:
      case "Ident":
      case "BasicLit":
      case "BinaryExpr":
      case "ParenExpr":
      case "SelectorExpr":
      case "IndexExpr":
      case "SliceExpr":
      case "TypeAssertExpr":
      case "StarExpr":
      case "CompositeLit":
      case "KeyValueExpr":
      case "FieldList":
      case "Field":
      case "Ellipsis":
      case "IndexListExpr":
        break;
      case "ArrayType":
      case "StructType":
      case "ChanType":
      case "FuncType":
      case "MapType":
      case "InterfaceType":
        // Type syntax has no effects.
        return false;
      case "UnaryExpr":
        if (n.op === token.ARROW) {
          result = false;
        }
        break;
      case "CallExpr":
        // Conversions and pure builtins such as len have no effects themselves.
        if (!(info.types.get(n.fun!)?.isType() ?? false) && !callsPureBuiltin(info, n)) {
          result = false;
        }
        break;
      case "FuncLit":
        return false;
      default:
        result = false;
    }
    return result;
  });
  return result;
}

const pureBuiltins = new Set(["len", "cap", "complex", "imag", "real", "make", "new", "max", "min"]);

function callsPureBuiltin(info: types.Info, call: ast.CallExpr): boolean {
  const id = ast.unparen(call.fun);
  if (id?.$type === "Ident") {
    const b = info.objectOf(id);
    return b?.$type === "Builtin" && pureBuiltins.has(b.name());
  }
  return false;
}

/** Reports whether pkg directly imports the package path. */
export function imports(pkg: types.Package, path: string): boolean {
  return pkg.imports().some((imported) => imported!.path() === path);
}
