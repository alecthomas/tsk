// Port of golang.org/x/tools/go/analysis/passes/inline at v0.50.0, without
// the inliner (internal/refactor/inline): it reports but suggests no fixes.
import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import * as edge from "golang.org/x/tools/go/ast/edge";
import type * as inspector from "golang.org/x/tools/go/ast/inspector";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer, defineFact, formatNode, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { before } from "./internal/goversion";
import { coreType, deref } from "./internal/typeparams";
import { isPackageLevel, receiverNamed } from "./internal/typesinternal";

// What the inliner's callee analysis records that the checks here need.
interface FuncFact {
  // "pkg.Func" or "(pkg.T).Method".
  name: string;
  pkgPath: string;
  // The Go version of the declaring file.
  goVersion: string;
  // The first free reference to a non-exported symbol, or "".
  unexported: string;
  // The packages of the body's free references.
  imports: string[];
}

// Describes "const LHS = RHS".
interface ConstFact {
  rhsName: string;
  rhsPkgPath: string;
  rhsPkgName: string;
}

const funcFact = defineFact<FuncFact>("goFixInline");
const constFact = defineFact<ConstFact>("goFixInline const");
// An alias's fact holds nothing: it exists only to mark the alias inlinable.
const aliasFact = defineFact<Record<string, never>>("goFixInline alias");

export default defineAnalyzer({
  name: "inline",
  doc: `apply fixes based on 'go:fix inline' comment directives

The inline analyzer reports calls to functions, and uses of constants
and type aliases, that are marked for inlining with a "//go:fix inline"
directive, in the same or other packages:

	//go:fix inline
	func Square(x int) int { return Pow(x, 2) }

	//go:fix inline
	const Ptr = Pointer

	//go:fix inline
	type A = newpkg.A

A constant can be marked for inlining only if it refers to another
named constant. The directive may precede a const or type declaration
on its own, one in a group, or a group, applying to all of it.

A use of a symbol X from its dedicated test (TestX, BenchmarkX,
ExampleX, or FuzzX), or from foo_test.go when X is declared in foo.go,
is not reported.

Unlike upstream, this port does not run the inliner, so it suggests no
fixes, and reports calls the inliner would decline to reduce.`,
  url: "https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/inline",
  group: "govet",
  requires: [inspect],
  facts: [funcFact, constFact, aliasFact],
  scope: "all",
  run(pass) {
    new Inliner(pass).run();
  },
});

// A constant marked for inlining; rhsObj is set for one whose RHS is in the current package.
interface InlinableConst extends ConstFact {
  rhsObj?: types.Object;
}

class Inliner {
  private readonly root: inspector.Cursor;
  // Memoised fact imports; null means no fact.
  private readonly funcs = new Map<types.Func, FuncFact | null>();
  private readonly consts = new Map<types.Const, InlinableConst | null>();
  private readonly aliases = new Map<types.TypeName, boolean>();

  constructor(private readonly pass: Pass<unknown>) {
    this.root = pass.resultOf(inspect).root();
  }

  run(): void {
    for (const fileCursor of this.root.children()) {
      if (this.mayHaveDirective(fileCursor.node() as ast.File)) {
        this.findDirectives(fileCursor);
      }
    }
    // Facts are all a dependency is analysed for.
    if (!this.pass.dependency) {
      this.inline();
    }
  }

  // Reports whether a file's source mentions the directive, so files without
  // it, as nearly all of a dependency's are, are not walked.
  private mayHaveDirective(file: ast.File): boolean {
    const tokenFile = this.pass.fset.file(file.pos());
    if (tokenFile === null) {
      return true;
    }
    try {
      return this.pass.readFile(tokenFile.name()).includes("//go:fix");
    } catch {
      return true;
    }
  }

  // Port of gofixdirective.Find.
  private findDirectives(fileCursor: inspector.Cursor): void {
    for (const cursor of fileCursor.preorder(ast.FuncDecl, ast.GenDecl)) {
      const decl = cursor.node() as ast.FuncDecl | ast.GenDecl;
      if (decl.$type === "FuncDecl") {
        if (hasFixInline(decl.doc)) {
          this.handleFunc(cursor, decl);
        }
        continue;
      }
      if (decl.tok !== token.CONST && decl.tok !== token.TYPE) {
        continue;
      }
      // The directive may be on the whole declaration or on individual specs.
      const declInline = hasFixInline(decl.doc);
      for (const spec of decl.specs) {
        if (spec?.$type === "TypeSpec") {
          this.findAlias(spec, declInline);
        } else if (spec?.$type === "ValueSpec") {
          this.findConst(spec, declInline);
        }
      }
    }
  }

  private findAlias(spec: ast.TypeSpec, declInline: boolean): void {
    if (!declInline && !hasFixInline(spec.doc)) {
      return;
    }
    if (spec.assign === token.NoPos) {
      this.pass.report({ pos: spec.pos(), message: "invalid //go:fix inline directive: not a type alias" });
      return;
    }
    // Array lengths other than literals are disallowed, as go/types gives only
    // the value of a named constant length, which inlining would lose.
    for (const n of ast.preorder(spec.type)) {
      if (n?.$type === "ArrayType" && n.len !== null) {
        const lit = ast.unparen(n.len);
        if (lit?.$type === "BasicLit" && lit.kind === token.INT) {
          continue;
        }
        this.pass.report({ pos: spec.pos(), message: "invalid //go:fix inline directive: array types not supported" });
        return;
      }
    }
    const lhs = this.pass.typesInfo.defs.get(spec.name!) as types.TypeName;
    this.aliases.set(lhs, true);
    // Only exported package-level aliases get facts, even if the RHS is not
    // exported, so uses in other packages are reported.
    if (lhs.exported() && isPackageLevel(lhs)) {
      this.pass.exportObjectFact(lhs, aliasFact, {});
    }
  }

  private findConst(spec: ast.ValueSpec, declInline: boolean): void {
    if (!declInline && !hasFixInline(spec.doc)) {
      return;
    }
    const iota = types.Universe!.lookup("iota");
    for (const [i, nameIdent] of spec.names.entries()) {
      // Following an iota, there may be no value.
      if (i >= spec.values.length) {
        break;
      }
      const val = spec.values[i]!;
      let rhsIdent: ast.Ident;
      if (val.$type === "Ident") {
        if (this.pass.typesInfo.uses.get(val) === iota) {
          this.pass.report({ pos: val.pos(), message: "invalid //go:fix inline directive: const value is iota" });
          return;
        }
        rhsIdent = val;
      } else if (val.$type === "SelectorExpr") {
        rhsIdent = val.sel!;
      } else {
        this.pass.report({ pos: val.pos(), message: "invalid //go:fix inline directive: const value is not the name of another constant" });
        return;
      }
      this.handleConst(nameIdent!, rhsIdent);
    }
  }

  private handleConst(nameIdent: ast.Ident, rhsIdent: ast.Ident): void {
    const lhs = this.pass.typesInfo.defs.get(nameIdent);
    const rhs = this.pass.typesInfo.uses.get(rhsIdent);
    if (lhs?.$type !== "Const" || rhs?.$type !== "Const") {
      return;
    }
    const rhsPkg = rhs.pkg()!;
    const con: InlinableConst = { rhsName: rhs.name(), rhsPkgPath: rhsPkg.path(), rhsPkgName: rhsPkg.name() };
    if (rhsPkg === this.pass.pkg) {
      con.rhsObj = rhs;
    }
    this.consts.set(lhs, con);
    if (lhs.exported() && isPackageLevel(lhs)) {
      this.pass.exportObjectFact(lhs, constFact, { rhsName: con.rhsName, rhsPkgPath: con.rhsPkgPath, rhsPkgName: con.rhsPkgName });
    }
  }

  // Records what the inliner's callee analysis would, for the checks the
  // inliner makes before inlining a call.
  private handleFunc(cursor: inspector.Cursor, decl: ast.FuncDecl): void {
    const info = this.pass.typesInfo;
    const fn = info.defs.get(decl.name!) as types.Func;
    const recv = fn.signature()!.recv();
    const name = recv === null ? `${fn.pkg()!.name()}.${fn.name()}` : `(${types.typeString(recv.type(), (p) => p!.name())}).${fn.name()}`;
    if (decl.body === null) {
      this.pass.report({ pos: decl.doc!.pos(), message: `invalid inlining candidate: cannot inline function ${name} as it has no body` });
      return;
    }
    const within = (pos: token.Pos) => decl.pos() <= pos && pos < decl.end();
    // Of the non-exported references, the first in source order counts, as
    // upstream visits a struct literal's fields in turn with their values.
    let unexported = "";
    let unexportedPos = 0;
    const addUnexported = (pos: token.Pos, sym: string) => {
      if (unexported === "" || pos < unexportedPos) {
        unexported = sym;
        unexportedPos = pos;
      }
    };
    const imports = new Set<string>();
    for (const c of cursor.preorder(ast.SelectorExpr, ast.CompositeLit, ast.Ident)) {
      const n = c.node() as ast.SelectorExpr | ast.CompositeLit | ast.Ident;
      if (n.$type === "SelectorExpr") {
        const sel = info.selections.get(n) ?? null;
        if (sel !== null && !within(sel.obj()!.pos()) && !ast.isExported(n.sel!.name)) {
          addUnexported(n.pos(), `(${info.typeOf(n.x)!.string()}).${n.sel!.name}`);
        }
      } else if (n.$type === "CompositeLit") {
        const t = info.typeOf(n);
        const litType = t === null ? null : deref(t);
        const s = litType === null ? null : coreType(litType);
        if (s?.$type !== "Struct") {
          continue;
        }
        for (const [i, elt] of n.elts.entries()) {
          const field = elt!.$type === "KeyValueExpr" ? info.uses.get(elt.key as ast.Ident) : s.field(i);
          if (field?.$type === "Var" && !within(field.pos()) && !field.exported()) {
            addUnexported(elt!.pos(), `(${litType!.string()}).${field.name()}`);
          }
        }
      } else {
        if (c.parentEdgeKind() === edge.SelectorExpr_Sel) {
          continue;
        }
        const obj = info.uses.get(n) ?? null;
        // Fields and methods are handled by SelectorExpr and CompositeLit.
        if (obj === null || (obj.$type === "Var" && obj.isField()) || (obj.$type === "Func" && obj.signature()!.recv() !== null)) {
          continue;
        }
        const objPkg = obj.pkg();
        if (!ast.isExported(n.name) && objPkg !== null && obj.parent() === objPkg.scope()) {
          addUnexported(n.pos(), n.name);
        }
        if (obj === fn || !within(obj.pos())) {
          if (/^_C(func|type|var)_/.test(obj.name())) {
            this.pass.report({ pos: decl.doc!.pos(), message: "invalid inlining candidate: cannot inline cgo-generated functions" });
            return;
          }
          const path = obj.$type === "PkgName" ? obj.imported()!.path() : (objPkg?.path() ?? "");
          if (path !== "") {
            imports.add(path);
          }
        }
      }
    }
    const file = cursor.enclosing(ast.File).next().value?.node() as ast.File | undefined;
    const goVersion = (file && info.fileVersions.get(file)) ?? "";
    const fact: FuncFact = { name, pkgPath: this.pass.pkg.path(), goVersion, unexported, imports: [...imports].sort() };
    this.pass.exportObjectFact(fn, funcFact, fact);
    this.funcs.set(fn, fact);
  }

  // Reports each static call to an inlinable function and each reference to
  // an inlinable constant or type alias.
  private inline(): void {
    for (const cursor of this.root.preorder(ast.CallExpr, ast.Ident)) {
      const n = cursor.node() as ast.CallExpr | ast.Ident;
      if (n.$type === "CallExpr") {
        this.inlineCall(n, cursor);
        continue;
      }
      const obj = this.pass.typesInfo.uses.get(n) ?? null;
      if (obj?.$type === "TypeName") {
        this.inlineAlias(obj, cursor);
      } else if (obj?.$type === "Const") {
        this.inlineConst(obj, cursor);
      }
    }
  }

  private inlineCall(call: ast.CallExpr, cursor: inspector.Cursor): void {
    const fn = typeutil.staticCallee(this.pass.typesInfo, call);
    if (fn === null) {
      return;
    }
    let callee = this.funcs.get(fn);
    if (callee === undefined) {
      callee = this.pass.importObjectFact(fn, funcFact) ?? null;
      this.funcs.set(fn, callee);
    }
    if (callee === null || this.withinTestOf(cursor, fn)) {
      return;
    }
    // These are the inliner's checks that need no inlining. Calls it would
    // literalize, or need a binding declaration for, are still reported.
    const failure = this.inlineFailure(callee, cursor);
    if (failure !== null) {
      this.pass.report({ pos: call.lparen, message: failure });
      return;
    }
    // The inliner's edits are not computed, so there is no suggested fix.
    this.pass.report({ pos: call.pos(), end: call.end(), category: "inline_call", message: `Call of ${callee.name} should be inlined` });
  }

  // Returns the error the inliner reports before inlining a call, or null.
  private inlineFailure(callee: FuncFact, cursor: inspector.Cursor): string | null {
    const file = enclosingFile(cursor);
    if (ast.isGenerated(file)) {
      return "cannot inline calls from generated files";
    }
    const callerPath = this.pass.pkg.path();
    if (callerPath !== callee.pkgPath && callee.unexported !== "") {
      return `cannot inline call to ${callee.name} because body refers to non-exported ${callee.unexported}`;
    }
    const callerGoVersion = this.pass.typesInfo.fileVersions.get(file) ?? "";
    if (callerGoVersion !== "" && callee.goVersion !== "" && before(callerGoVersion, callee.goVersion)) {
      return `cannot inline call to ${callee.name} (declared using ${callee.goVersion}) into a file using ${callerGoVersion}`;
    }
    const inaccessible = callee.imports.find((path) => path !== callerPath && !canImport(callerPath, path));
    if (inaccessible !== undefined) {
      return `can't inline function ${callee.name} as its body refers to inaccessible package "${inaccessible}"`;
    }
    return null;
  }

  // Reports whether a use is within a dedicated test of target, such as TestX
  // or ExampleT_M, or in x_test.go when target is declared in x.go.
  private withinTestOf(curUse: inspector.Cursor, target: types.Object): boolean {
    const useFile = this.pass.fset.file(curUse.node()!.pos())?.name() ?? "";
    if (!useFile.endsWith("_test.go")) {
      return false;
    }
    const targetFile = this.pass.fset.file(target.pos())?.name();
    if (targetFile !== undefined && useFile.slice(0, -"_test.go".length) === trimSuffix(targetFile, ".go")) {
      return true;
    }
    const funcDecl = curUse.enclosing(ast.FuncDecl).next().value?.node() as ast.FuncDecl | undefined;
    if (funcDecl === undefined || funcDecl.recv !== null) {
      return false;
    }
    if (trimSuffix(this.pass.pkg.path(), "_test") !== target.pkg()?.path()) {
      return false;
    }
    let symbol = target.name();
    if (target.$type === "Func") {
      const recv = target.signature()!.recv();
      if (recv !== null) {
        symbol = `${receiverNamed(recv).named?.obj()?.name()}_${symbol}`;
      }
    }
    const fname = funcDecl.name!.name;
    return ["Test", "Example", "Bench", "Fuzz"].some((pre) => fname === pre + symbol || fname.startsWith(`${pre + symbol}_`));
  }

  private inlineAlias(tn: types.TypeName, curId: inspector.Cursor): void {
    let inlinable = this.aliases.get(tn);
    if (inlinable === undefined) {
      inlinable = this.pass.importObjectFact(tn, aliasFact) !== undefined;
      this.aliases.set(tn, inlinable);
    }
    if (!inlinable || this.withinTestOf(curId, tn)) {
      return;
    }
    const alias = tn.type() as types.Alias;
    // The alias's type parameters will not appear in the replacement, so
    // shadowing does not matter for them.
    const typeParamNames = new Set<types.Object>();
    for (const tp of alias.typeParams()?.typeParams() ?? []) {
      typeParamNames.add(tp!.obj()!);
    }
    let rhs = alias.rhs();
    const curPath = this.pass.pkg.path();
    const curFile = enclosingFile(curId);
    const id = curId.node() as ast.Ident;
    // The complete identifier may be Id, pkg.Id, Id[T], or pkg.Id[K, V].
    let expr = id as ast.Expr;
    if (curId.parentEdgeKind() === edge.SelectorExpr_Sel) {
      curId = curId.parent();
      expr = curId.node() as ast.Expr;
    }
    const kind = curId.parentEdgeKind();
    if (kind === edge.IndexExpr_X || kind === edge.IndexListExpr_X) {
      curId = curId.parent();
      expr = curId.node() as ast.Expr;
    }
    // Inlining an alias naming an embedded field must not change the field's name.
    const def = this.pass.typesInfo.defs.get(id) ?? null;
    if (def?.$type === "Var" && def.embedded()) {
      const named = alias.rhs();
      if (named?.$type !== "Named" || alias.obj()!.name() !== named.obj()!.name()) {
        return;
      }
    }
    const t = this.pass.typesInfo.typeOf(expr) as types.Alias;
    const targs = t.typeArgs();
    if (targs !== null && targs.len() > 0) {
      // Given type A = M[K, V], the use A[int, Foo] has type M[int, Foo].
      const instAlias = types.instantiate(null, alias, [...targs.types()], false) as types.Alias;
      rhs = instAlias.rhs();
    }
    // A can be replaced by rhs if no name in rhs is shadowed at the use, and
    // every package in rhs can be imported here.
    for (const name of typenames(rhs)) {
      if (typeParamNames.has(name)) {
        continue;
      }
      const pkgPath = name.pkg()?.path() ?? "";
      if (pkgPath === "" || pkgPath === curPath) {
        const scope = this.pass.typesInfo.scopes.get(curFile)!.innermost(id.pos())!;
        const [, obj] = scope.lookupParent(name.name(), id.pos());
        if (obj !== name) {
          return;
        }
      } else if (!canImport(curPath, pkgPath)) {
        return;
      }
    }
    this.reportInline("Type alias", expr);
  }

  private inlineConst(con: types.Const, cur: inspector.Cursor): void {
    let incon = this.consts.get(con);
    if (incon === undefined) {
      incon = this.pass.importObjectFact(con, constFact) ?? null;
      this.consts.set(con, incon);
    }
    if (incon === null || this.withinTestOf(cur, con)) {
      return;
    }
    const n = cur.node() as ast.Ident;
    // B must mean in n's scope what it means where "const A = B" is declared.
    // AddImport would handle shadowing of an RHS in another package.
    if (this.pass.pkg.path() === incon.rhsPkgPath) {
      const scope = this.pass.typesInfo.scopes.get(enclosingFile(cur))!.innermost(n.pos())!;
      const [, obj] = scope.lookupParent(incon.rhsName, n.pos());
      if (obj === null || obj !== incon.rhsObj) {
        return;
      }
    } else if (!canImport(this.pass.pkg.path(), incon.rhsPkgPath)) {
      return;
    }
    const expr = cur.parentEdgeKind() === edge.SelectorExpr_Sel ? (cur.parent().node() as ast.Expr) : n;
    this.reportInline("Constant", expr);
  }

  // The fix replacing the name is dropped with the inliner's.
  private reportInline(capKind: string, expr: ast.Expr): void {
    this.pass.report({ pos: expr.pos(), end: expr.end(), message: `${capKind} ${formatNode(expr, this.pass.fset)} should be inlined` });
  }
}

// Reports whether the comments hold a "//go:fix inline" directive, as
// internal/astutil.Directives parses them.
function hasFixInline(cg: ast.CommentGroup | null): boolean {
  for (const c of cg?.list ?? []) {
    const text = c!.text;
    if (text.startsWith("//go:fix ")) {
      // A line comment may follow the arguments.
      const args = text.slice("//go:fix ".length);
      const end = args.indexOf("//");
      if ((end < 0 ? args : args.slice(0, end)).trim() === "inline") {
        return true;
      }
    }
  }
  return false;
}

function enclosingFile(cursor: inspector.Cursor): ast.File {
  return cursor.enclosing(ast.File).next().value!.node() as ast.File;
}

function trimSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s.slice(0, -suffix.length) : s;
}

// Port of internal/packagepath.CanImport: whether a package may import
// another under the go command's rules for internal packages.
function canImport(from: string, to: string): boolean {
  if (to === "internal" || to.startsWith("internal/")) {
    const first = from.split("/")[0]!;
    // Neither example.com/foo nor testdata/foo is in std.
    if (first.includes(".") || first === "testdata") {
      return false;
    }
  }
  if (to.endsWith("/internal")) {
    return from.startsWith(to.slice(0, -"/internal".length));
  }
  const i = to.lastIndexOf("/internal/");
  if (i >= 0) {
    return from.startsWith(to.slice(0, i));
  }
  return true;
}

// Returns the type names within t, including t itself: those of basic,
// named, and alias types, and type parameters. Names may repeat.
function typenames(t: types.Type | null): types.TypeName[] {
  const tns: types.TypeName[] = [];
  const visit = (t: types.Type | null): void => {
    if (t === null) {
      return;
    }
    switch (t.$type) {
      case "Basic":
        tns.push(types.Universe!.lookup(t.name()) as types.TypeName);
        break;
      case "Named":
      case "Alias":
        tns.push(t.obj()!);
        for (const arg of t.typeArgs()?.types() ?? []) {
          visit(arg);
        }
        break;
      case "TypeParam":
        tns.push(t.obj()!);
        break;
      case "Pointer":
      case "Slice":
      case "Array":
      case "Chan":
        visit(t.elem());
        break;
      case "Map":
        visit(t.key());
        visit(t.elem());
        break;
      case "Struct":
        for (let i = 0; i < t.numFields(); i++) {
          visit(t.field(i)!.type());
        }
        break;
      case "Signature":
        // Receivers and type parameters cannot appear in a type expression.
        visit(t.params());
        visit(t.results());
        break;
      case "Interface":
        for (let i = 0; i < t.numEmbeddeds(); i++) {
          visit(t.embeddedType(i));
        }
        for (let i = 0; i < t.numExplicitMethods(); i++) {
          visit(t.explicitMethod(i)!.type());
        }
        break;
      case "Tuple":
        for (let i = 0; i < t.len(); i++) {
          visit(t.at(i)!.type());
        }
        break;
    }
  };
  visit(t);
  return tns;
}
