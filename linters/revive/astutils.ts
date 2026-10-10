// Ports revive's internal/astutils, internal/typeparams, and rule/utils.go
// helpers (v1.17.0, MIT license), shared by several rules.

import * as ast from "go/ast";
import * as token from "go/token";
import type * as types from "go/types";
import { formatNode } from "tsk";

/** Visits a node and returns the visitor for its children, as ast.Visitor does. */
export interface Visitor {
  visit(node: ast.Node | null): Visitor | null;
}

/** Walks node depth-first as ast.Walk does, calling visit(null) after children. */
export function walk(visitor: Visitor, node: ast.Node): void {
  const stack: Visitor[] = [visitor];
  ast.inspect(node, (n) => {
    if (n === null) {
      stack.pop()!.visit(null);
      return true;
    }
    const next = stack[stack.length - 1].visit(n);
    if (next === null) {
      return false;
    }
    stack.push(next);
    return true;
  });
}

/** Reports whether fn has the given name, parameter types, and result types. */
export function funcSignatureIs(fn: ast.FuncDecl, name: string, params: string[], results: string[]): boolean {
  return fn.name!.name === name && sameNames(getTypeNames(fn.type!.results), results) && sameNames(getTypeNames(fn.type!.params), params);
}

// sameNames compares as slices.Equal does, so a nil list equals an empty one.
function sameNames(a: string[] | null, b: string[]): boolean {
  const list = a ?? [];
  return list.length === b.length && list.every((n, i) => n === b[i]);
}

/** One type name per field name, or null for a missing field list. */
export function getTypeNames(fields: ast.FieldList | null): string[] | null {
  if (fields === null) {
    return null;
  }
  return fields.list.flatMap((field) => {
    const name = fieldTypeName(field!.type!);
    return field!.names.length === 0 ? [name] : field!.names.map(() => name);
  });
}

function fieldTypeName(typ: ast.Expr): string {
  switch (typ.$type) {
    case "Ident":
      return (typ as ast.Ident).name;
    case "SelectorExpr": {
      const sel = typ as ast.SelectorExpr;
      return `${fieldTypeName(sel.x!)}.${fieldTypeName(sel.sel!)}`;
    }
    case "StarExpr":
      return `*${fieldTypeName((typ as ast.StarExpr).x!)}`;
    case "IndexExpr": {
      const index = typ as ast.IndexExpr;
      return `${fieldTypeName(index.x!)}[${fieldTypeName(index.index!)}]`;
    }
    case "ArrayType":
      return `[]${fieldTypeName((typ as ast.ArrayType).elt!)}`;
    case "InterfaceType":
      return "interface{}";
    default:
      return "UNHANDLED_TYPE";
  }
}

/** The receiver's type name, without "*" or type parameters, or "invalid-type". */
export function receiverType(fn: ast.FuncDecl): string {
  let e = fn.recv!.list[0]!.type!;
  if (e.$type === "StarExpr") {
    e = (e as ast.StarExpr).x!;
  }
  if (e.$type === "IndexExpr" || e.$type === "IndexListExpr") {
    e = (e as ast.IndexExpr | ast.IndexListExpr).x!;
  }
  return e.$type === "Ident" ? (e as ast.Ident).name : "invalid-type";
}

export function isStringLiteral(e: ast.Node | null): boolean {
  return e !== null && e.$type === "BasicLit" && (e as ast.BasicLit).kind === token.STRING;
}

/** Reports whether fn is exported to C with an //export comment. */
export function isCgoExported(fn: ast.FuncDecl): boolean {
  if (fn.recv !== null || fn.doc === null) {
    return false;
  }
  const directive = `//export ${fn.name!.name}`;
  // Go's (?m)^...$ matches the directive as any whole line of the comment.
  return fn.doc.list.some((c) => c!.text.split("\n").includes(directive));
}

export function isIdent(expr: ast.Node | null, name: string): boolean {
  return expr !== null && expr.$type === "Ident" && (expr as ast.Ident).name === name;
}

/** Reports whether expr is the selector pkg.name. */
export function isPkgDotName(expr: ast.Node | null, pkg: string, name: string): boolean {
  if (expr === null || expr.$type !== "SelectorExpr") {
    return false;
  }
  const sel = expr as ast.SelectorExpr;
  return isIdent(sel.x, pkg) && isIdent(sel.sel, name);
}

/** Reports whether typ is a pointer to the named type pkgPath.typeName. */
export function isPointerToPkgDotType(typ: types.Type | null, pkgPath: string, typeName: string): boolean {
  if (typ === null || typ.$type !== "Pointer") {
    return false;
  }
  const elem = (typ as types.Pointer).elem();
  if (elem === null || elem.$type !== "Named") {
    return false;
  }
  const obj = (elem as types.Named).obj();
  return obj !== null && obj.pkg() !== null && obj.pkg()!.path() === pkgPath && obj.name() === typeName;
}

/** Every node under n, n included, that selector picks, in walk order. */
export function pickNodes(n: ast.Node | null, selector: (n: ast.Node) => boolean): ast.Node[] {
  const result: ast.Node[] = [];
  if (n !== null) {
    ast.inspect(n, (node) => {
      if (node !== null && selector(node)) {
        result.push(node);
      }
      return true;
    });
  }
  return result;
}

/** The first node under n, n included, that selector picks, or null. */
export function seekNode(n: ast.Node | null, selector: (n: ast.Node) => boolean): ast.Node | null {
  let found: ast.Node | null = null;
  if (n !== null) {
    walk(
      {
        visit(node) {
          if (found !== null || node === null) {
            return null;
          }
          if (selector(node)) {
            found = node;
            return null;
          }
          return this;
        },
      },
      n,
    );
  }
  return found;
}

/**
 * Prints a node without its source positions, as revive's GoFmt does. Rules
 * also use it as the node's hash, where revive hashes this text.
 */
export function goFmt(node: ast.Node): string {
  return formatNode(node);
}

type ExitCheck = (args: readonly (ast.Expr | null)[]) => boolean;

const always: ExitCheck = () => true;

const exitFunctions = new Map<string, Map<string, ExitCheck>>([
  ["os", new Map([["Exit", always]])],
  ["syscall", new Map([["Exit", always]])],
  [
    "log",
    new Map(["Fatal", "Fatalf", "Fatalln", "Panic", "Panicf", "Panicln"].map((name) => [name, always])),
  ],
  [
    "flag",
    new Map([
      ["Parse", always],
      ["NewFlagSet", (args) => args.length === 2 && isPkgDotName(args[1], "flag", "ExitOnError")],
    ]),
  ],
]);

/** Reports whether pkgName.functionName(args...) exits the program. */
export function isCallToExitFunction(pkgName: string, functionName: string, args: readonly (ast.Expr | null)[]): boolean {
  const check = exitFunctions.get(pkgName)?.get(functionName);
  return check !== undefined && check(args);
}

/** Removes hyphens, underscores, and dots, so "foo.bar-_buz" is "foobarbuz". */
export function normalizePath(name: string): string {
  return name.replace(/[-_.]/g, "");
}

/** Reports whether a directory name is a major version, such as v2 or V3. */
export function isVersionPath(name: string): boolean {
  return /^[vV][0-9]+$/.test(name);
}

// See https://go-review.googlesource.com/c/website/+/442516/1..2/_content/doc/comment.md#494.
const directiveComment = /^\/\/(line |extern |export |[a-z0-9]+:[a-z0-9])/;

/** Reports whether a comment line is a directive, such as //go:generate. */
export function isDirectiveComment(line: string): boolean {
  return directiveComment.test(line);
}
