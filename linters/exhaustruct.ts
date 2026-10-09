import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { type Directive, optionality, Scanner } from "./exhaustruct/directives";
import { isEnforced, isIgnored, PatternList, Processor, type Struct, skippedFields } from "./exhaustruct/structure";

interface Config {
  /** Patterns of types or Type#Field names to check; types are only selected in explicit mode. */
  enforcePatterns: readonly string[];
  /** Patterns of types to skip; they outrank enforce-patterns. */
  ignorePatterns: readonly string[];
  /** Patterns of types or Type#Field names whose fields are optional. */
  optionalPatterns: readonly string[];
  /** Allow empty literals of every type. */
  allowEmpty: boolean;
  /** Patterns of types allowed to be empty. */
  allowEmptyPatterns: readonly string[];
  /** Allow empty literals in return statements. */
  allowEmptyReturns: boolean;
  /** Allow empty literals in variable declarations. */
  allowEmptyDeclarations: boolean;
  /** Allow empty literals assigned to the blank identifier. */
  allowEmptyBlankAssignments: boolean;
  /** Check only types enforced by a directive or pattern. */
  explicitMode: boolean;
}

// Literal is the context of one composite literal being checked.
interface Literal {
  pass: Pass<Config>;
  processor: Processor;
  lit: ast.CompositeLit;
  // The literal's ancestors, from its file down to the literal itself.
  stack: ast.Node[];
}

export default defineAnalyzer<Config>({
  name: "exhaustruct",
  doc: "Checks if all structure fields are initialized",
  requires: [inspect],
  config: {
    enforcePatterns: [],
    ignorePatterns: [],
    optionalPatterns: [],
    allowEmpty: false,
    allowEmptyPatterns: [],
    allowEmptyReturns: false,
    allowEmptyDeclarations: false,
    allowEmptyBlankAssignments: false,
    explicitMode: false,
  },
  run(pass) {
    const c = pass.config;
    const scanner = new Scanner(pass.fset);
    const processor = new Processor(pass.fset, scanner, {
      enforce: new PatternList(c.enforcePatterns),
      ignore: new PatternList(c.ignorePatterns),
      optional: new PatternList(c.optionalPatterns),
      allowEmpty: new PatternList(c.allowEmptyPatterns),
    });
    for (const d of scanner.processFiles(pass.files as ast.File[])) {
      pass.report(d);
    }
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CompositeLit)) {
      const stack: ast.Node[] = [];
      for (let cur = cursor; cur.node() !== null; cur = cur.parent()) {
        stack.unshift(cur.node()!);
      }
      check({ pass, processor, lit: cursor.node() as ast.CompositeLit, stack });
    }
  },
});

function check(l: Literal): void {
  const resolved = resolveLiteralType(l);
  if (resolved === null) {
    return;
  }
  const s = l.processor.resolveStruct(resolved.name, resolved.strct, resolved.pos, l.pass.pkg);
  if (l.lit.elts.length === 0 && emptyAllowed(l, s)) {
    return;
  }
  const dirs = useSiteDirectives(l);
  if (!shouldCheck(s, dirs, l.pass.config.explicitMode)) {
    return;
  }
  const missing = skippedFields(s, l.lit, l.pass.pkg.path(), canNamePromoted(l));
  if (missing.length === 0) {
    return;
  }
  const names = missing.map((f) => f.name).join(", ");
  const plural = missing.length === 1 ? "field" : "fields";
  l.pass.report({ pos: l.lit.pos(), message: `${s.packageName}.${s.name} is missing ${plural} ${names}` });
}

// shouldCheck ranks a use-site directive over the type's directives and
// patterns.
function shouldCheck(s: Struct, dirs: Directive[], explicitMode: boolean): boolean {
  if (dirs.includes("ignore")) {
    return false;
  }
  if (dirs.includes("enforce")) {
    return true;
  }
  if (isIgnored(s)) {
    return false;
  }
  return isEnforced(s) || !explicitMode;
}

const exprTypes = new Set([
  "BadExpr",
  "Ident",
  "Ellipsis",
  "BasicLit",
  "FuncLit",
  "CompositeLit",
  "ParenExpr",
  "SelectorExpr",
  "IndexExpr",
  "IndexListExpr",
  "SliceExpr",
  "TypeAssertExpr",
  "CallExpr",
  "StarExpr",
  "UnaryExpr",
  "BinaryExpr",
  "KeyValueExpr",
  "ArrayType",
  "StructType",
  "FuncType",
  "InterfaceType",
  "MapType",
  "ChanType",
]);
const declOrSpecTypes = new Set(["ImportSpec", "ValueSpec", "TypeSpec", "BadDecl", "GenDecl", "FuncDecl"]);
const stmtTypes = new Set([
  "BadStmt",
  "DeclStmt",
  "EmptyStmt",
  "LabeledStmt",
  "ExprStmt",
  "SendStmt",
  "IncDecStmt",
  "AssignStmt",
  "GoStmt",
  "DeferStmt",
  "ReturnStmt",
  "BranchStmt",
  "BlockStmt",
  "IfStmt",
  "CaseClause",
  "SwitchStmt",
  "TypeSwitchStmt",
  "CommClause",
  "SelectStmt",
  "ForStmt",
  "RangeStmt",
]);

// useSiteDirectives collects the directives written above the literal: it
// climbs through expressions, specs and declarations, and stops at the first
// statement so a directive on an if or for does not reach its whole block.
function useSiteDirectives(l: Literal): Directive[] {
  const dirs: Directive[] = [];
  for (const node of [...l.stack].reverse()) {
    const isStmt = stmtTypes.has(node.$type);
    if (!isStmt && !exprTypes.has(node.$type) && !declOrSpecTypes.has(node.$type)) {
      break;
    }
    for (const d of l.processor.directives.lookupPos(node.pos())) {
      if (!dirs.includes(d)) {
        dirs.push(d);
      }
    }
    if (isStmt) {
      break;
    }
  }
  return dirs;
}

function typeNameOf(t: types.Type | null): types.TypeName | null {
  switch (t?.$type) {
    case "Alias":
    case "Named":
    case "TypeParam":
      return t.obj();
    default:
      return null;
  }
}

// resolveLiteralType returns the struct a literal builds, the declaration it
// is written under, and where that declaration's directives are.
function resolveLiteralType(l: Literal): { name: types.TypeName | null; strct: types.Struct; pos: token.Pos } | null {
  let t = l.pass.typesInfo.typeOf(l.lit);
  // A literal may elide &T where the element type is a pointer.
  let name = typeNameOf(t);
  const under = types.unalias(t)?.underlying();
  if (under?.$type === "Pointer") {
    t = under.elem();
    if (name === null) {
      name = typeNameOf(t);
    }
  }
  t = types.unalias(t);
  switch (t?.$type) {
    case "Named": {
      // Every instantiation shares the declaration's fields and directives.
      const strct = t.origin()!.underlying();
      return strct?.$type === "Struct" ? { name, strct, pos: name!.pos() } : null;
    }
    case "TypeParam": {
      const strct = constraintCore(l, t.constraint(), new Set(), new Map());
      // A type parameter has no declaration to read directives from.
      return strct.ok && strct.core !== null ? { name, strct: strct.core, pos: token.NoPos } : null;
    }
    case "Struct":
      return { name, strct: t, pos: name !== null ? name.pos() : anonymousStructPos(l) };
    default:
      return null;
  }
}

interface Core {
  core: types.Struct | null;
  ok: boolean;
}

// constraintCore resolves the struct every term of a constraint shares.
// Method-only interfaces leave the core of their siblings standing.
function constraintCore(l: Literal, t: types.Type | null, walking: Set<types.Interface>, done: Map<types.Interface, Core>): Core {
  const iface = t?.underlying();
  if (iface?.$type !== "Interface") {
    return { core: null, ok: false };
  }
  if (walking.has(iface)) {
    return { core: null, ok: true };
  }
  const known = done.get(iface);
  if (known !== undefined) {
    return known;
  }
  walking.add(iface);
  const result = ((): Core => {
    let core: types.Struct | null = null;
    for (const embedded of iface.embeddedTypes()) {
      const terms = embedded?.$type === "Union" ? [...embedded.terms()].map((term) => term!.type()) : [embedded];
      for (const term of terms) {
        const sub: Core = term?.underlying()?.$type === "Interface" ? constraintCore(l, term, walking, done) : structCore(term);
        if (!sub.ok) {
          return { core: null, ok: false };
        }
        if (sub.core === null) {
          continue;
        }
        if (core !== null && !sameCore(l, core, sub.core)) {
          return { core: null, ok: false };
        }
        core = sub.core;
      }
    }
    return { core, ok: true };
  })();
  walking.delete(iface);
  done.set(iface, result);
  return result;
}

function structCore(t: types.Type | null): Core {
  const strct = t?.underlying();
  return strct?.$type === "Struct" ? { core: strct, ok: true } : { core: null, ok: false };
}

// sameCore reports whether two terms are one struct, or two declarations of
// one shape whose fields are annotated alike.
function sameCore(l: Literal, a: types.Struct, b: types.Struct): boolean {
  if (a === b) {
    return true;
  }
  if (!types.identical(a, b)) {
    return false;
  }
  for (let i = 0; i < a.numFields(); i++) {
    const oa = optionality(l.processor.fieldDirectives(a.field(i)!));
    const ob = optionality(l.processor.fieldDirectives(b.field(i)!));
    if (oa.optional !== ob.optional || oa.enforced !== ob.enforced) {
      return false;
    }
  }
  return true;
}

// anonymousStructPos finds the struct keyword of an unnamed struct, written on
// the literal or on the enclosing literal whose elements elide it.
function anonymousStructPos(l: Literal): token.Pos {
  if (l.lit.type !== null) {
    return l.lit.type.$type === "StructType" ? l.lit.type.struct : token.NoPos;
  }
  // A map literal's keys and values come from opposite sides of its type.
  let mapKey = false;
  for (let i = l.stack.length - 2; i >= 0; i--) {
    const parent = l.stack[i];
    if (parent.$type === "KeyValueExpr") {
      mapKey = parent.key === l.stack[i + 1];
      continue;
    }
    if (parent.$type !== "CompositeLit") {
      return token.NoPos;
    }
    const typ = parent.type;
    if (typ?.$type === "ArrayType") {
      return structPos(typ.elt);
    }
    if (typ?.$type === "MapType") {
      return structPos(mapKey ? typ.key : typ.value);
    }
    return token.NoPos;
  }
  return token.NoPos;
}

function structPos(expr: ast.Expr | null): token.Pos {
  const t = expr?.$type === "StarExpr" ? expr.x : expr;
  return t?.$type === "StructType" ? t.struct : token.NoPos;
}

function emptyAllowed(l: Literal, s: Struct): boolean {
  const c = l.pass.config;
  if (c.allowEmpty || s.allowEmptyDecl) {
    return true;
  }
  const { parent, child } = enclosingOfLiteral(l);
  if (parent?.$type === "ReturnStmt" && (c.allowEmptyReturns || isErrorReturn(l, parent))) {
    return true;
  }
  const declared = parent?.$type === "ValueSpec" || (parent?.$type === "AssignStmt" && parent.tok === token.DEFINE);
  if (declared && c.allowEmptyDeclarations) {
    return true;
  }
  return c.allowEmptyBlankAssignments && isBlankAssignment(parent, child);
}

// enclosingOfLiteral returns the node the literal is written into, past
// parentheses and &, and the expression that node holds directly.
function enclosingOfLiteral(l: Literal): { parent: ast.Node | null; child: ast.Expr | null } {
  let child: ast.Expr = l.lit;
  for (let i = l.stack.length - 1; i > 0; i--) {
    const p = l.stack[i - 1];
    if (p.$type === "ParenExpr" || (p.$type === "UnaryExpr" && p.op === token.AND)) {
      child = p;
      continue;
    }
    if (p.$type === "UnaryExpr") {
      return { parent: null, child: null };
    }
    return { parent: p, child };
  }
  return { parent: null, child: null };
}

function isBlankAssignment(parent: ast.Node | null, child: ast.Expr | null): boolean {
  let values: readonly (ast.Expr | null)[];
  let names: readonly (ast.Expr | null)[];
  if (parent?.$type === "ValueSpec") {
    [values, names] = [parent.values, parent.names];
  } else if (parent?.$type === "AssignStmt") {
    [values, names] = [parent.rhs, parent.lhs];
  } else {
    return false;
  }
  const i = values.indexOf(child);
  const target = i >= 0 && i < names.length ? unparen(names[i]) : null;
  return target?.$type === "Ident" && target.name === "_";
}

function isErrorReturn(l: Literal, ret: ast.ReturnStmt): boolean {
  const errorIface = types.Universe!.lookup("error")!.type()!.underlying() as types.Interface;
  for (const result of [...ret.results].reverse()) {
    const r = unparen(result);
    if (r === l.lit || (r?.$type === "Ident" && r.name === "nil") || (r?.$type === "UnaryExpr" && unparen(r.x) === l.lit)) {
      continue;
    }
    const t = l.pass.typesInfo.typeOf(r);
    if (t !== null && types.implements_(t, errorIface)) {
      return true;
    }
  }
  return false;
}

function unparen(expr: ast.Expr | null): ast.Expr | null {
  let e = expr;
  while (e?.$type === "ParenExpr") {
    e = e.x;
  }
  return e;
}

// canNamePromoted reports whether the literal's file may name promoted fields
// as keys, which Go allows since 1.27. Unknown versions read as the newest.
function canNamePromoted(l: Literal): boolean {
  const file = l.stack[0] as ast.File;
  const version = l.pass.typesInfo.fileVersions.get(file) || l.pass.pkg.goVersion();
  const match = /^go(\d+)(?:\.(\d+))?(?:\.\d+|(?:rc|beta)\d+)?$/.exec(version);
  if (match === null) {
    return true;
  }
  const [major, minor] = [Number(match[1]), Number(match[2] ?? 0)];
  return major > 1 || (major === 1 && minor >= 27);
}
