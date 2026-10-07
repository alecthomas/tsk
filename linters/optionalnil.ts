import * as ast from "go/ast";
import * as constant from "go/constant";
import * as token from "go/token";
import * as types from "go/types";
import * as edge from "golang.org/x/tools/go/ast/edge";
import type * as inspector from "golang.org/x/tools/go/ast/inspector";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { defineAnalyzer, defineFact, type Pass } from "tsk";
import { inspect } from "tsk/passes";

// generatedPackage marks a package whose files are all generated. Its API
// follows the generator's conventions, so nil uses of it are not reported.
const generatedPackage = defineFact<Record<string, never>>("generatedPackage");

export default defineAnalyzer({
  name: "optionalnil",
  doc: `report when nil is used to mean "no value"

In the module being linted, reports a nil that stands for a missing value
where an option type could be used instead: nil returned, stored in a variable,
field, or map, passed as an argument, or compared with a value. Only types
whose nil can mean absent count: pointers, interfaces with methods, functions,
and channels, plus slices and maps in comparisons.

Some nils are not reported: errors; pointers ending a linked structure, which
point to their own type; nil returned beside an error or a false ok flag; a
nil check that fails when the value is missing, which treats it as required;
and the APIs of generated packages and other modules. Test files may pass nil
arguments and store nil map values.`,
  requires: [inspect],
  facts: [generatedPackage],
  run(pass) {
    const module = pass.module;
    if (module === undefined || !inModule(pass.pkg.path(), module.path)) {
      return; // Neither dependencies nor test mains are first-party.
    }
    if (allGenerated(pass.files)) {
      pass.exportPackageFact(generatedPackage, {});
      return;
    }
    const root = pass.resultOf(inspect).root();
    const checker = new Checker(pass, root, module.path);
    for (const cursor of root.preorder(ast.Ident).filter(pass.typesInfo.isNil)) {
      checker.checkNil(cursor);
    }
  },
});

class Checker {
  private readonly info: types.Info;
  private readonly errorType: types.Interface;
  private readonly tracked = new Set<types.Object>();

  constructor(
    private readonly pass: Pass<unknown>,
    root: inspector.Cursor,
    private readonly module: string,
  ) {
    this.info = pass.typesInfo;
    this.errorType = types.Universe!.lookup("error")!.type()!.underlying() as types.Interface;
    this.trackLocals(root);
  }

  // checkNil reports a nil literal whose destination is a first-party slot for
  // a value that may be absent.
  checkNil(cursor: inspector.Cursor): void {
    while (this.keepsNil(cursor.parent().node())) {
      cursor = cursor.parent();
    }
    const [kind, index] = cursor.parentEdge();
    const parent = cursor.parent();
    switch (kind) {
      case edge.ReturnStmt_Results:
        this.checkReturn(parent, index);
        break;
      case edge.AssignStmt_Rhs: {
        const assign = parent.node() as ast.AssignStmt;
        if (assign.lhs.length !== assign.rhs.length) {
          break;
        }
        const target = assign.lhs[index];
        if (target?.$type === "IndexExpr") {
          this.checkMapValue(cursor, this.info.typeOf(target.x));
        } else {
          this.checkStore(cursor, this.referencedVar(target));
        }
        break;
      }
      case edge.ValueSpec_Values: {
        const spec = parent.node() as ast.ValueSpec;
        if (spec.names.length === spec.values.length) {
          this.checkStore(cursor, this.referencedVar(spec.names[index]));
        }
        break;
      }
      case edge.KeyValueExpr_Value: {
        if (parent.parentEdgeKind() !== edge.CompositeLit_Elts) {
          break;
        }
        const literalType = this.info.typeOf(parent.parent().node() as ast.CompositeLit);
        const underlying = literalType?.underlying();
        if (underlying?.$type === "Struct") {
          this.checkStore(cursor, this.referencedVar((parent.node() as ast.KeyValueExpr).key));
        } else if (underlying?.$type === "Map") {
          this.checkMapValue(cursor, literalType);
        }
        break;
      }
      case edge.CompositeLit_Elts: {
        const structType = this.info.typeOf(parent.node() as ast.CompositeLit)?.underlying();
        if (structType?.$type === "Struct") {
          this.checkStore(cursor, structType.field(index));
        }
        break;
      }
      case edge.CallExpr_Args:
        this.checkArgument(cursor, parent.node() as ast.CallExpr, index);
        break;
      case edge.BinaryExpr_X:
      case edge.BinaryExpr_Y:
        this.checkComparison(parent, kind);
        break;
    }
  }

  private checkReturn(ret: inspector.Cursor, index: number): void {
    const stmt = ret.node() as ast.ReturnStmt;
    const signature = this.enclosingSignature(ret);
    const results = signature?.results();
    if (!results || results.len() !== stmt.results.length || this.isPlaceholder(stmt, index)) {
      return;
    }
    if (this.mayBeAbsent(results.at(index)!.type(), false)) {
      this.report(stmt.results[index]!, "nil returned");
    }
  }

  // isPlaceholder reports whether another result carries the outcome, such as
  // an error or a false ok flag, so the nil only fills its slot.
  private isPlaceholder(stmt: ast.ReturnStmt, index: number): boolean {
    for (const [i, result] of stmt.results.entries()) {
      if (i === index || this.isNil(result)) {
        continue;
      }
      const value = this.info.types.get(result!)?.value ?? null;
      if (value === null || (value.kind() === constant.Bool && !constant.boolVal(value))) {
        return true;
      }
    }
    return false;
  }

  // keepsNil reports whether a node passes a nil operand through unchanged, as
  // parentheses and conversions such as (*T)(nil) do.
  private keepsNil(node: ast.Node | null): boolean {
    if (node?.$type === "ParenExpr") {
      return true;
    }
    if (node?.$type === "CallExpr") {
      return node.args.length === 1 && (this.info.types.get(node.fun!)?.isType() ?? false);
    }
    return false;
  }

  private isNil(expr: ast.Expr | null): boolean {
    for (;;) {
      expr = ast.unparen(expr);
      if (expr?.$type !== "CallExpr" || !this.keepsNil(expr)) {
        return expr !== null && (this.info.types.get(expr)?.isNil() ?? false);
      }
      expr = expr.args[0];
    }
  }

  // checkMapValue reports nil stored as a map value, where a missing key
  // already means absent. Tests skip it, as their tables pass nil inputs
  // deliberately.
  private checkMapValue(cursor: inspector.Cursor, mapType: types.Type | null): void {
    const underlying = mapType?.underlying();
    if (underlying?.$type !== "Map" || this.inTestFile(cursor.node()!)) {
      return;
    }
    const named = types.unalias(mapType);
    if (named?.$type === "Named" && !this.isFirstParty(named.obj()!)) {
      return; // A map type declared elsewhere keeps its package's conventions.
    }
    if (this.mayBeAbsent(underlying.elem(), false)) {
      this.report(cursor.node()!, "nil stored in map");
    }
  }

  private checkStore(cursor: inspector.Cursor, target: types.Var | null | undefined): void {
    if (target && target.name() !== "_" && this.isFirstParty(target) && this.mayBeAbsent(target.type(), false)) {
      this.report(cursor.node()!, `nil stored in ${target.name()}`);
    }
  }

  private checkArgument(cursor: inspector.Cursor, call: ast.CallExpr, index: number): void {
    const callee = typeutil.callee(this.info, call);
    const signature = this.info.typeOf(call.fun)?.underlying();
    if (callee === null || signature?.$type !== "Signature" || !this.isFirstParty(callee) || this.inTestFile(call)) {
      return;
    }
    const params = signature.params()!;
    let paramType: types.Type | null;
    if (!signature.variadic() || index < params.len() - 1) {
      paramType = params.at(index)!.type();
    } else if (call.ellipsis === token.NoPos) {
      paramType = (params.at(params.len() - 1)!.type() as types.Slice).elem();
    } else {
      return;
    }
    if (this.mayBeAbsent(paramType, false)) {
      this.report(cursor.node()!, `nil passed to ${callee.name()}`);
    }
  }

  // checkComparison reports a nil comparison that tests whether a first-party
  // value is present. Slices and maps count since nil there separates absent
  // from empty.
  private checkComparison(cursor: inspector.Cursor, nilSide: edge.Kind): void {
    const comparison = cursor.node() as ast.BinaryExpr;
    if (comparison.op !== token.EQL && comparison.op !== token.NEQ) {
      return;
    }
    const operand = nilSide === edge.BinaryExpr_X ? comparison.y : comparison.x;
    const object = this.referencedObject(operand);
    if (object === undefined || !this.isFirstParty(object) || !this.mayBeAbsent(this.info.typeOf(operand), true)) {
      return;
    }
    if (isLocal(object) && !this.tracked.has(object)) {
      return; // Its nil came from code outside the module.
    }
    if (comparison.op === token.EQL && this.isRequirementCheck(cursor)) {
      return;
    }
    this.report(comparison, `nil compared with ${object.name()}`);
  }

  // isRequirementCheck reports whether a nil comparison fails when the value
  // is missing, which treats the value as required rather than optional.
  private isRequirementCheck(cursor: inspector.Cursor): boolean {
    while (
      cursor.parentEdgeKind() === edge.ParenExpr_X ||
      ((cursor.parentEdgeKind() === edge.BinaryExpr_X || cursor.parentEdgeKind() === edge.BinaryExpr_Y) &&
        (cursor.parent().node() as ast.BinaryExpr).op === token.LOR)
    ) {
      cursor = cursor.parent();
    }
    if (cursor.parentEdgeKind() !== edge.IfStmt_Cond) {
      return false;
    }
    const body = (cursor.parent().node() as ast.IfStmt).body!.list;
    return body.length > 0 && this.fails(body[body.length - 1]);
  }

  // fails reports whether a statement panics or returns a non-nil error.
  private fails(stmt: ast.Stmt | null): boolean {
    if (stmt?.$type === "ExprStmt") {
      if (stmt.x?.$type !== "CallExpr") {
        return false;
      }
      const builtin = typeutil.callee(this.info, stmt.x);
      return builtin?.$type === "Builtin" && builtin.name() === "panic";
    }
    if (stmt?.$type === "ReturnStmt") {
      for (const result of stmt.results) {
        const value = this.info.types.get(result!);
        if (value !== undefined && types.implements_(value.type, this.errorType) && !value.isNil()) {
          return true;
        }
      }
    }
    return false;
  }

  // mayBeAbsent reports whether nil can mean absent for a type. It cannot for
  // errors, self-referential pointers ending a linked structure, or any
  // holding JSON null.
  private mayBeAbsent(valueType: types.Type | null, includeCollections: boolean): boolean {
    if (valueType === null || types.unalias(valueType)?.$type === "TypeParam" || types.implements_(valueType, this.errorType)) {
      return false;
    }
    const underlying = valueType.underlying();
    switch (underlying?.$type) {
      case "Pointer":
        return !isSelfReferential(valueType, underlying);
      case "Interface":
        return !underlying.empty();
      case "Signature":
      case "Chan":
        return true;
      case "Slice":
      case "Map":
        return includeCollections;
    }
    return false;
  }

  // isFirstParty reports whether an object belongs to the analysed module and
  // was written by hand.
  private isFirstParty(object: types.Object): boolean {
    const pkg = object.pkg();
    if (pkg === null || !inModule(pkg.path(), this.module)) {
      return false;
    }
    return this.pass.importPackageFact(pkg, generatedPackage) === undefined;
  }

  private referencedVar(expr: ast.Expr | null): types.Var | undefined {
    const object = this.referencedObject(expr);
    return object?.$type === "Var" ? object : undefined;
  }

  // referencedObject returns the variable, field, or called function an
  // expression names.
  private referencedObject(expr: ast.Expr | null): types.Var | types.Func | undefined {
    const unwrapped = ast.unparen(expr);
    let object: types.Object | null = null;
    if (unwrapped?.$type === "Ident") {
      object = this.info.objectOf(unwrapped);
    } else if (unwrapped?.$type === "SelectorExpr") {
      object = this.info.objectOf(unwrapped.sel);
    } else if (unwrapped?.$type === "CallExpr") {
      object = typeutil.callee(this.info, unwrapped);
    }
    return object?.$type === "Var" || object?.$type === "Func" ? object : undefined;
  }

  private enclosingSignature(cursor: inspector.Cursor): types.Signature | undefined {
    for (const function_ of cursor.enclosing(ast.FuncDecl, ast.FuncLit)) {
      const node = function_.node();
      let signature: types.Type | null | undefined;
      if (node?.$type === "FuncDecl") {
        signature = this.info.defs.get(node.name!)?.type();
      } else if (node?.$type === "FuncLit") {
        signature = this.info.typeOf(node);
      }
      return signature?.$type === "Signature" ? signature : undefined;
    }
    return undefined;
  }

  private inTestFile(node: ast.Node): boolean {
    return this.pass.fset.position(node.pos()).filename.endsWith("_test.go");
  }

  private report(node: ast.Node, what: string): void {
    this.pass.report({ pos: node.pos(), message: `${what}; use an option type for a value that may be absent` });
  }

  // trackLocals records the locals whose nil originates in the module: those
  // declared without a value and those set from a first-party call.
  private trackLocals(root: inspector.Cursor): void {
    for (const cursor of root.preorder(ast.ValueSpec, ast.AssignStmt)) {
      const node = cursor.node();
      let names: readonly (ast.Expr | null)[];
      let values: readonly (ast.Expr | null)[];
      if (node?.$type === "ValueSpec") {
        names = node.names;
        values = node.values;
      } else if (node?.$type === "AssignStmt" && node.tok === token.DEFINE) {
        names = node.lhs;
        values = node.rhs;
      } else {
        continue;
      }
      if (values.length > 0 && !this.isFirstPartyCall(values)) {
        continue;
      }
      for (const name of names) {
        const object = this.info.defs.get(name as ast.Ident);
        if (object && isLocal(object)) {
          this.tracked.add(object);
        }
      }
    }
  }

  private isFirstPartyCall(values: readonly (ast.Expr | null)[]): boolean {
    if (values.length !== 1) {
      return false;
    }
    const call = ast.unparen(values[0]);
    if (call?.$type !== "CallExpr") {
      return false;
    }
    const callee = typeutil.callee(this.info, call);
    return callee !== null && this.isFirstParty(callee);
  }
}

function isSelfReferential(pointer: types.Type, underlying: types.Pointer): boolean {
  const structType = underlying.elem()?.underlying();
  if (structType?.$type !== "Struct") {
    return false;
  }
  for (const field of structType.fields()) {
    if (types.identical(field!.type(), pointer)) {
      return true;
    }
  }
  return false;
}

function inModule(pkgPath: string, module: string): boolean {
  return pkgPath === module || pkgPath.startsWith(`${module}/`);
}

// isLocal reports whether an object is a variable declared inside a function,
// excluding parameters and results.
function isLocal(object: types.Object): boolean {
  return object.$type === "Var" && object.kind() === types.LocalVar;
}

function allGenerated(files: readonly ast.File[]): boolean {
  return files.length > 0 && files.every((file) => ast.isGenerated(file));
}
