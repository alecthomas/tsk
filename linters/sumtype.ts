import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer, defineFact, type Pass } from "tsk";
import { inspect } from "tsk/passes";

interface Config {
  /** A default clause makes a type switch exhaustive, unless it only panics. */
  defaultSignifiesExhaustive: boolean;
  /** A case for an interface covers every variant that implements it. */
  includeSharedInterfaces: boolean;
  /** Sealed interfaces, such as "example.com/pkg.Node", to treat as sum types. */
  types: string[];
}

// SumType names a sum type's concrete variants in its package scope.
// Interfaces extending the sum type are left out; their implementations are listed.
interface SumType {
  variants: string[];
}

const sumType = defineFact<SumType>("sumType");

const directive = "//sumtype:decl";

export default defineAnalyzer<Config>({
  name: "sumtype",
  doc: `check exhaustiveness of type switches on sum types

A sum type is a sealed interface, one with at least one unexported method,
declared with a //sumtype:decl comment. Its variants are the concrete types in
its package that implement it. A type switch on a sum type must have a case
for every variant, or a default clause that does more than panic.

The types option names further sum types by full package path, for sealed
interfaces in packages that cannot carry the comment, such as dependencies.`,
  requires: [inspect],
  facts: [sumType],
  config: { defaultSignifiesExhaustive: true, includeSharedInterfaces: false, types: [] },
  // Sum types declared in other modules are known only through their facts.
  scope: "all",
  run(pass) {
    const configured = configuredTypes(pass);
    const root = pass.resultOf(inspect).root();
    // Declarations are exported first, so switches can import this package's
    // facts as well as those of its dependencies.
    for (const cursor of root.preorder(ast.GenDecl)) {
      declare(pass, cursor.node() as ast.GenDecl);
    }
    for (const name of configured) {
      declareConfigured(pass, name);
    }
    // Findings in dependencies are discarded, so only their facts matter.
    if (pass.dependency) {
      return;
    }
    for (const cursor of root.preorder(ast.TypeSwitchStmt)) {
      checkSwitch(pass, cursor.node() as ast.TypeSwitchStmt);
    }
  },
});

function declare(pass: Pass<Config>, decl: ast.GenDecl): void {
  // The parser attaches an ungrouped spec's comment to its GenDecl.
  const grouped = decl.lparen !== token.NoPos;
  if (hasDirective(decl.doc) && (grouped || decl.tok !== token.TYPE)) {
    pass.report({ pos: decl.pos(), message: `${directive} must annotate a single type declaration` });
    return;
  }
  for (const spec of decl.specs) {
    if (spec?.$type === "TypeSpec" && (hasDirective(spec.doc) || (!grouped && hasDirective(decl.doc)))) {
      defineSumType(pass, spec);
    }
  }
}

function hasDirective(doc: ast.CommentGroup | null): boolean {
  return doc?.list.some((comment) => comment!.text.startsWith(directive)) ?? false;
}

function defineSumType(pass: Pass<Config>, spec: ast.TypeSpec): void {
  const object = pass.typesInfo.defs.get(spec.name!);
  if (object?.$type !== "TypeName") {
    return;
  }
  const problem = sumTypeProblem(pass, object);
  if (problem !== null) {
    pass.report({ pos: spec.pos(), message: problem });
    return;
  }
  exportSumType(pass, object);
}

// configuredTypes returns the names in the types option declared in this
// package, without their package path.
function configuredTypes(pass: Pass<Config>): string[] {
  const names: string[] = [];
  for (const qualified of pass.config.types) {
    const dot = qualified.lastIndexOf(".");
    const name = qualified.slice(dot + 1);
    if (dot <= 0 || !token.isIdentifier(name)) {
      throw new Error(`types: invalid type "${qualified}", want a full package path and type name such as "example.com/pkg.Type"`);
    }
    if (qualified.slice(0, dot) === pass.pkg.path()) {
      names.push(name);
    }
  }
  return names;
}

// declareConfigured throws rather than reports, because findings in
// dependencies, where configured types usually live, are discarded.
function declareConfigured(pass: Pass<Config>, name: string): void {
  const object = pass.pkg.scope()!.lookup(name);
  const qualified = `${pass.pkg.path()}.${name}`;
  if (object?.$type !== "TypeName") {
    throw new Error(`types: type "${qualified}" is not declared`);
  }
  // The type also carries a //sumtype:decl comment.
  if (pass.importObjectFact(object, sumType) !== undefined) {
    return;
  }
  const problem = sumTypeProblem(pass, object);
  if (problem !== null) {
    throw new Error(`types: ${qualified}: ${problem}`);
  }
  exportSumType(pass, object);
}

// sumTypeProblem explains why object cannot be a sum type, or returns null.
function sumTypeProblem(pass: Pass<Config>, object: types.TypeName): string | null {
  const name = object.name();
  if (object.parent() !== pass.pkg.scope()) {
    return `sum type '${name}' must be declared at package level`;
  }
  const iface = object.type()?.underlying();
  if (iface?.$type !== "Interface") {
    return `type '${name}' is not an interface`;
  }
  if (!isSealed(iface)) {
    return `interface '${name}' is not sealed (sealing requires at least one unexported method)`;
  }
  return null;
}

function exportSumType(pass: Pass<Config>, object: types.TypeName): void {
  const iface = object.type()!.underlying() as types.Interface;
  pass.exportObjectFact(object, sumType, { variants: variants(pass.pkg, iface) });
}

// isSealed reports whether only the interface's own package can implement it.
function isSealed(iface: types.Interface): boolean {
  for (const method of iface.methods()) {
    if (!method!.exported()) {
      return true;
    }
  }
  return false;
}

function variants(pkg: types.Package, iface: types.Interface): string[] {
  const scope = pkg.scope()!;
  return scope.names().filter((name) => {
    // Aliases are not Named, so they never add a second name for a variant.
    const named = scope.lookup(name)?.type() ?? null;
    return named?.$type === "Named" && (named.typeParams()?.len() ?? 0) === 0 && named.underlying()?.$type !== "Interface" && implementedBy(named, iface);
  });
}

function checkSwitch(pass: Pass<Config>, stmt: ast.TypeSwitchStmt): void {
  const info = pass.typesInfo;
  const named = types.unalias(info.typeOf(assertedExpr(stmt.assign)));
  const object = named?.$type === "Named" ? named.obj() : null;
  const fact = object === null ? undefined : pass.importObjectFact(object, sumType);
  if (object === null || fact === undefined) {
    return;
  }
  const cases: types.Type[] = [];
  let handlesDefault = false;
  for (const clause of stmt.body!.list) {
    if (clause?.$type !== "CaseClause") {
      continue;
    }
    if (clause.list.length === 0) {
      handlesDefault = !onlyPanics(info, clause);
    }
    for (const expr of clause.list) {
      const t = indirect(info.typeOf(expr));
      if (t !== null) {
        cases.push(t);
      }
    }
  }
  if (handlesDefault && pass.config.defaultSignifiesExhaustive) {
    return;
  }
  const scope = object.pkg()!.scope()!;
  const missing = fact.variants.filter((name) => {
    const variant = scope.lookup(name)?.type() ?? null;
    return variant !== null && !cases.some((t) => covers(t, variant, pass.config.includeSharedInterfaces));
  });
  if (missing.length === 0) {
    return;
  }
  const location = pass.fset.position(object.pos()).string();
  pass.report({
    pos: stmt.pos(),
    message: `exhaustiveness check failed for sum type "${object.name()}" (from ${location}): missing cases for ${missing.sort().join(", ")}`,
  });
}

// assertedExpr returns x from a type switch guard, either x.(type) or v := x.(type).
function assertedExpr(guard: ast.Stmt | null): ast.Expr | null {
  const expr = guard?.$type === "AssignStmt" ? guard.rhs[0] : guard?.$type === "ExprStmt" ? guard.x : null;
  return expr?.$type === "TypeAssertExpr" ? expr.x : null;
}

function onlyPanics(info: types.Info, clause: ast.CaseClause): boolean {
  const stmt = clause.body.length === 1 ? clause.body[0] : null;
  const call = stmt?.$type === "ExprStmt" ? ast.unparen(stmt.x) : null;
  const callee = call?.$type === "CallExpr" ? typeutil.callee(info, call) : null;
  return callee?.$type === "Builtin" && callee.name() === "panic";
}

function covers(t: types.Type, variant: types.Type, sharedInterfaces: boolean): boolean {
  if (types.identical(t, variant)) {
    return true;
  }
  const iface = t.underlying();
  return sharedInterfaces && iface?.$type === "Interface" && implementedBy(variant, iface);
}

function indirect(t: types.Type | null): types.Type | null {
  t = types.unalias(t);
  return t?.$type === "Pointer" ? indirect(t.elem()) : t;
}

function implementedBy(t: types.Type, iface: types.Interface): boolean {
  return types.implements_(t, iface) || types.implements_(types.newPointer(t), iface);
}
