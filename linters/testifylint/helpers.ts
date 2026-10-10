// Helpers shared by testifylint's checkers, after its checkers package.
import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";
import { type Diagnostic, formatNode, type Pass, type SuggestedFix, type TextEdit, type TypeToken } from "tsk";
import { inspect } from "tsk/passes";
import { unquote } from "../internal/strconv";

export type AnyPass = Pass<unknown>;

const modulePath = "github.com/stretchr/testify";
export const assertPkgPath = `${modulePath}/assert`;
export const requirePkgPath = `${modulePath}/require`;
export const suitePkgPath = `${modulePath}/suite`;
export const testifyPackages = new Set([modulePath, assertPkgPath, `${modulePath}/http`, `${modulePath}/mock`, requirePkgPath, suitePkgPath]);

const errorType = types.Universe!.lookup("error")!.type()!;
const errorIface = errorType.underlying() as types.Interface;

export interface Range {
  pos(): token.Pos;
  end(): token.Pos;
}

// CallMeta describes a call of a testify assert or require function or
// method, such as assert.Equal(t, 1, 2) or s.Require().Equal(1, 2).
export interface CallMeta {
  call: ast.CallExpr;
  // isPkg is set for package functions rather than methods.
  isPkg: boolean;
  isAssert: boolean;
  selector: ast.SelectorExpr;
  selectorXStr: string;
  fn: FnMeta;
  // args omits the leading testing.T, which argsRaw keeps.
  args: ast.Expr[];
  argsRaw: ast.Expr[];
}

export interface FnMeta {
  ident: ast.Ident;
  name: string;
  // nameFTrimmed drops the trailing "f" of formatted variants.
  nameFTrimmed: string;
  isFmt: boolean;
  signature: types.Signature;
}

export function callString(call: CallMeta): string {
  return `${call.selectorXStr}.${call.fn.name}`;
}

export function newCallMeta(pass: AnyPass, call: ast.CallExpr): CallMeta | null {
  const se = call.fun;
  if (se?.$type !== "SelectorExpr" || se.sel === null) {
    return null;
  }
  let initiatorPkg: types.Package | null = null;
  let isPkg = false;
  const selection = pass.typesInfo.selections.get(se);
  if (selection) {
    initiatorPkg = selection.obj()?.pkg() ?? null;
  } else if (se.x?.$type === "Ident") {
    const object = pass.typesInfo.objectOf(se.x);
    if (object?.$type === "PkgName") {
      initiatorPkg = object.imported();
      isPkg = true;
    }
  }
  if (initiatorPkg === null) {
    return null;
  }
  const isAssert = isPkgNamed(initiatorPkg, "assert", assertPkgPath);
  if (!isAssert && !isPkgNamed(initiatorPkg, "require", requirePkgPath)) {
    return null;
  }
  const fn = typeutil.callee(pass.typesInfo, call);
  if (fn?.$type !== "Func") {
    return null;
  }
  const name = se.sel.name;
  const argsRaw = call.args as ast.Expr[];
  return {
    call,
    isPkg,
    isAssert,
    selector: se,
    selectorXStr: nodeString(pass, se.x!),
    fn: { ident: se.sel, name, nameFTrimmed: name.replace(/f$/, ""), isFmt: name.endsWith("f"), signature: fn.type() as types.Signature },
    args: argsRaw.length > 0 && implementsTestingT(pass, argsRaw[0]) ? argsRaw.slice(1) : argsRaw,
    argsRaw,
  };
}

function isPkgNamed(pkg: types.Package, name: string, path: string): boolean {
  return pkg.name() === name && trimVendor(pkg.path()) === path;
}

function trimVendor(path: string): string {
  return path.startsWith("vendor/") ? path.slice("vendor/".length) : path;
}

// objectOf looks a name up in the package or one it imports directly.
export function objectOf(pkg: types.Package, objPkg: string, name: string): types.Object | null {
  if (pkg.path() === objPkg) {
    return pkg.scope()!.lookup(name);
  }
  const imported = pkg.imports().find((i) => trimVendor(i!.path()) === objPkg);
  return imported?.scope()?.lookup(name) ?? null;
}

export function isObj(pass: AnyPass, expr: ast.Expr | null, expected: types.Object | null): boolean {
  return expr?.$type === "Ident" && pass.typesInfo.objectOf(expr) === expected;
}

export function nodeString(pass: AnyPass, node: ast.Node): string {
  return formatNode(node, pass.fset);
}

export function formatAsCallArgs(pass: AnyPass, ...args: ast.Expr[]): string {
  return args.map((arg) => nodeString(pass, arg)).join(", ");
}

// stringLiteral returns the value of a string literal, as strconv.Unquote
// of its source does, or null.
export function stringLiteral(expr: ast.Expr): string | null {
  return expr.$type === "BasicLit" && expr.kind === token.STRING ? unquote(expr.value) : null;
}

// Diagnostics.

export function newDiagnostic(checker: string, range: Range, message: string, ...fixes: SuggestedFix[]): Diagnostic {
  return { pos: range.pos(), end: range.end(), category: checker, message: `${checker}: ${message}`, suggestedFixes: fixes };
}

export function newUseFunctionDiagnostic(checker: string, call: CallMeta, proposedFn: string, ...edits: TextEdit[]): Diagnostic {
  const f = call.fn.isFmt ? `${proposedFn}f` : proposedFn;
  return newDiagnostic(checker, call.call, `use ${call.selectorXStr}.${f}`, newSuggestedFuncReplacement(call, proposedFn, ...edits));
}

export function newRemoveFnAndUseDiagnostic(
  pass: AnyPass,
  checker: string,
  call: CallMeta,
  proposedFn: string,
  removedFn: string,
  removedFnPos: Range,
  ...removedFnArgs: ast.Expr[]
): Diagnostic {
  const f = call.fn.isFmt ? `${proposedFn}f` : proposedFn;
  return newDiagnostic(
    checker,
    call.call,
    `remove unnecessary ${removedFn} and use ${call.selectorXStr}.${f}`,
    newSuggestedFuncRemoving(pass, removedFn, removedFnPos, ...removedFnArgs),
    newSuggestedFuncReplacement(call, proposedFn),
  );
}

export function newRemoveFnDiagnostic(pass: AnyPass, checker: string, call: CallMeta, fnName: string, fnPos: Range, ...fnArgs: ast.Expr[]): Diagnostic {
  return newDiagnostic(checker, call.call, `remove unnecessary ${fnName}`, newSuggestedFuncRemoving(pass, fnName, fnPos, ...fnArgs));
}

function newSuggestedFuncRemoving(pass: AnyPass, fnName: string, fnPos: Range, ...fnArgs: ast.Expr[]): SuggestedFix {
  return { message: `Remove \`${fnName}\``, textEdits: [{ pos: fnPos.pos(), end: fnPos.end(), newText: formatAsCallArgs(pass, ...fnArgs) }] };
}

export function newSuggestedFuncReplacement(call: CallMeta, proposedFn: string, ...edits: TextEdit[]): SuggestedFix {
  const f = call.fn.isFmt ? `${proposedFn}f` : proposedFn;
  return { message: `Replace \`${call.fn.name}\` with \`${f}\``, textEdits: [newReplaceFnTextEdit(call.fn, f), ...edits] };
}

export function newReplaceFnTextEdit(fn: FnMeta, proposedFn: string): TextEdit {
  return { pos: fn.ident.pos(), end: fn.ident.end(), newText: proposedFn };
}

export function newRemoveLastArgTextEdit(pass: AnyPass, args: ast.Expr[]): TextEdit {
  return { pos: args[0].pos(), end: args[args.length - 1].end(), newText: formatAsCallArgs(pass, ...args.slice(0, -1)) };
}

export function replaceWith(pass: AnyPass, pos: token.Pos, end: token.Pos, expr: ast.Expr): TextEdit {
  return { pos, end, newText: nodeString(pass, expr) };
}

// Values and types.

// intLiteral returns the value of a decimal integer literal, possibly
// negated, as strconv.Atoi parses it.
export function intLiteral(expr: ast.Expr): number | null {
  if (expr.$type === "UnaryExpr" && expr.op === token.SUB) {
    const v = intLiteral(expr.x!);
    return v === null ? null : -v;
  }
  if (expr.$type !== "BasicLit" || expr.kind !== token.INT || !/^[+-]?\d+$/.test(expr.value)) {
    return null;
  }
  return Number(expr.value);
}

export function isIntNumber(expr: ast.Expr, value: number): boolean {
  return intLiteral(expr) === value;
}

export const isZero = (e: ast.Expr) => isIntNumber(e, 0);
export const isOne = (e: ast.Expr) => isIntNumber(e, 1);

function isTypedIntNumber(expr: ast.Expr, value: number, goTypes: string[]): boolean {
  return expr.$type === "CallExpr" && expr.args.length === 1 && expr.fun?.$type === "Ident" && goTypes.includes(expr.fun.name) && isIntNumber(expr.args[0]!, value);
}

const signedInts = ["int", "int8", "int16", "int32", "int64"];
const unsignedInts = ["uint", "uint8", "uint16", "uint32", "uint64"];

export function isAnyZero(e: ast.Expr): boolean {
  return isIntNumber(e, 0) || isTypedIntNumber(e, 0, signedInts) || isTypedIntNumber(e, 0, unsignedInts);
}

export function isZeroOrSignedZero(e: ast.Expr): boolean {
  return isIntNumber(e, 0) || isTypedIntNumber(e, 0, signedInts);
}

export function isStringLit(e: ast.Expr): boolean {
  return e.$type === "BasicLit" && e.kind === token.STRING;
}

export function isEmptyStringLit(e: ast.Expr): boolean {
  return e.$type === "BasicLit" && e.kind === token.STRING && (e.value === '""' || e.value === "``");
}

export function isBasicLit(e: ast.Expr): boolean {
  if (e.$type === "UnaryExpr" && e.op === token.SUB) {
    return isBasicLit(e.x!);
  }
  return e.$type === "BasicLit";
}

function basicInfo(pass: AnyPass, e: ast.Expr): number {
  const u = pass.typesInfo.typeOf(e)?.underlying();
  return u?.$type === "Basic" ? u.info() : 0;
}

export const isUntypedConst = (pass: AnyPass, e: ast.Expr) => (basicInfo(pass, e) & types.IsUntyped) > 0;
export const isFloat = (pass: AnyPass, e: ast.Expr) => (basicInfo(pass, e) & types.IsFloat) > 0;
export const isUnsigned = (pass: AnyPass, e: ast.Expr) => (basicInfo(pass, e) & types.IsUnsigned) > 0;

export function isTypedConst(pass: AnyPass, e: ast.Expr): boolean {
  const tv = pass.typesInfo.types.get(e);
  return tv !== undefined && tv !== null && tv.isValue() && tv.value !== null;
}

// pointerElem returns the element of an expression of pointer type.
export function pointerElem(pass: AnyPass, e: ast.Expr): types.Type | null {
  const t = pass.typesInfo.typeOf(e);
  return t?.$type === "Pointer" ? t.elem() : null;
}

export function isFunc(pass: AnyPass, e: ast.Expr): boolean {
  return pass.typesInfo.typeOf(e)?.$type === "Signature";
}

export function hasBytesType(pass: AnyPass, e: ast.Expr): boolean {
  const t = pass.typesInfo.typeOf(e);
  const elem = t?.$type === "Slice" ? t.elem() : null;
  return elem?.$type === "Basic" && elem.kind() === types.Uint8;
}

export function hasStringType(pass: AnyPass, e: ast.Expr): boolean {
  const t = pass.typesInfo.typeOf(e);
  return t?.$type === "Basic" && t.kind() === types.String;
}

export function hasBoolType(pass: AnyPass, e: ast.Expr): boolean {
  const t = pass.typesInfo.typeOf(e);
  return t?.$type === "Basic" && t.kind() === types.Bool;
}

export function isBoolOverride(pass: AnyPass, e: ast.Expr): boolean {
  const t = pass.typesInfo.typeOf(e);
  return t?.$type === "Named" && t.obj()?.name() === "bool";
}

export const isUntypedTrue = (pass: AnyPass, e: ast.Expr) => isObj(pass, e, types.Universe!.lookup("true"));
export const isUntypedFalse = (pass: AnyPass, e: ast.Expr) => isObj(pass, e, types.Universe!.lookup("false"));
export const isUntypedBool = (pass: AnyPass, e: ast.Expr) => isUntypedTrue(pass, e) || isUntypedFalse(pass, e);

export function isError(pass: AnyPass, e: ast.Expr): boolean {
  return pass.typesInfo.typeOf(e) === errorType;
}

export function implementsError(t: types.Type | null): boolean {
  return types.implements_(t, errorIface);
}

export { errorType };

export function isEmptyInterface(pass: AnyPass, e: ast.Expr): boolean {
  const tv = pass.typesInfo.types.get(e);
  return tv !== undefined && tv !== null && isEmptyInterfaceType(tv.type);
}

export function isEmptyInterfaceType(t: types.Type | null): boolean {
  const u = t?.underlying();
  return u?.$type === "Interface" && u.numMethods() === 0;
}

export function isNil(e: ast.Expr | null): boolean {
  return isIdentWithName("nil", e);
}

export function isIdentWithName(name: string, e: ast.Expr | null): boolean {
  return e?.$type === "Ident" && e.name === name;
}

export function isIdentNamedAfterPattern(pattern: RegExp, e: ast.Expr | null): boolean {
  return e?.$type === "Ident" && pattern.test(e.name);
}

// builtinLenArg returns x for a call of the builtin len(x).
export function builtinLenArg(pass: AnyPass, e: ast.Expr): ast.Expr | null {
  if (e.$type === "CallExpr" && e.args.length === 1 && isObj(pass, e.fun, types.Universe!.lookup("len"))) {
    return e.args[0];
  }
  return null;
}

// Comparisons.

export type Predicate = (pass: AnyPass, e: ast.Expr) => boolean;

export function isComparisonWithFloat(pass: AnyPass, e: ast.Expr, op: token.Token): boolean {
  return e.$type === "BinaryExpr" && e.op === op && (isFloat(pass, e.x!) || isFloat(pass, e.y!));
}

// comparisonWith returns the other operand of a comparison by op with exactly
// one operand matching predicate.
export function comparisonWith(pass: AnyPass, e: ast.Expr, predicate: Predicate, op: token.Token): ast.Expr | null {
  if (e.$type !== "BinaryExpr" || e.op !== op) {
    return null;
  }
  const t1 = predicate(pass, e.x!);
  const t2 = predicate(pass, e.y!);
  if (t1 === t2) {
    return null;
  }
  return t1 ? e.y : e.x;
}

// strictComparison returns the operands of "lhs op rhs" if they match.
export function strictComparison(pass: AnyPass, e: ast.Expr, lhs: Predicate, op: token.Token, rhs: Predicate): [ast.Expr, ast.Expr] | null {
  if (e.$type === "BinaryExpr" && e.op === op && lhs(pass, e.x!) && rhs(pass, e.y!)) {
    return [e.x!, e.y!];
  }
  return null;
}

export function negated(e: ast.Expr): ast.Expr | null {
  return e.$type === "UnaryExpr" && e.op === token.NOT ? e.x : null;
}

// Package functions.

export function isPkgFnCall(pass: AnyPass, call: ast.CallExpr, pkg: string, fn: string): boolean {
  if (call.fun?.$type !== "SelectorExpr") {
    return false;
  }
  const object = objectOf(pass.pkg, pkg, fn);
  return object !== null && isObj(pass, call.fun.sel, object);
}

export function fmtSprintfArgs(pass: AnyPass, e: ast.Expr): ast.Expr[] | null {
  return e.$type === "CallExpr" && isPkgFnCall(pass, e, "fmt", "Sprintf") ? (e.args as ast.Expr[]) : null;
}

// Interfaces.

function implementsObj(pass: AnyPass, e: ast.Expr, iface: types.Object | null): boolean {
  const t = pass.typesInfo.typeOf(e);
  return iface !== null && t !== null && types.implements_(t, iface.type()!.underlying() as types.Interface);
}

export function implementsTestifySuite(pass: AnyPass, e: ast.Expr): boolean {
  return implementsObj(pass, e, objectOf(pass.pkg, suitePkgPath, "TestingSuite"));
}

export function implementsTestingT(pass: AnyPass, e: ast.Expr): boolean {
  return implementsObj(pass, e, objectOf(pass.pkg, assertPkgPath, "TestingT")) || implementsObj(pass, e, objectOf(pass.pkg, requirePkgPath, "TestingT"));
}

export function implementsSuiteInterface(pass: AnyPass, e: ast.Expr, iface: string): boolean | null {
  const object = objectOf(pass.pkg, suitePkgPath, iface);
  return object === null ? null : implementsObj(pass, e, object);
}

// Suites and tests.

export function isSuiteMethod(pass: AnyPass, fn: ast.FuncDecl): boolean {
  return fn.recv?.list.length === 1 && implementsTestifySuite(pass, fn.recv.list[0]!.type!);
}

export const isSuiteTestMethod = (name: string) => name.startsWith("Test");

export function isSuiteServiceMethod(name: string): boolean {
  return [
    "T",
    "SetT",
    "SetS",
    "SetupSuite",
    "SetupTest",
    "TearDownSuite",
    "TearDownTest",
    "BeforeTest",
    "AfterTest",
    "HandleStats",
    "SetupSubTest",
    "TearDownSubTest",
  ].includes(name);
}

export function isSuiteAfterTestMethod(name: string): boolean {
  return ["TearDownSuite", "TearDownTest", "AfterTest", "HandleStats", "TearDownSubTest"].includes(name);
}

export function isSubTestRun(pass: AnyPass, call: ast.CallExpr): boolean {
  const se = call.fun;
  return se?.$type === "SelectorExpr" && se.sel !== null && (implementsTestingT(pass, se.x!) || implementsTestifySuite(pass, se.x!)) && se.sel.name === "Run";
}

export function hasTestingTParam(pass: AnyPass, ft: ast.FuncType | null): boolean {
  return (ft?.params?.list ?? []).some((param) => implementsTestingT(pass, param!.type!));
}

export function isTestingFuncOrMethod(pass: AnyPass, fn: ast.FuncDecl): boolean {
  return hasTestingTParam(pass, fn.type) || isSuiteMethod(pass, fn);
}

// mimicHTTPHandler reports whether a function's parameters match
// http.HandlerFunc's.
export function mimicHTTPHandler(pass: AnyPass, ft: ast.FuncType): boolean {
  const handler = objectOf(pass.pkg, "net/http", "HandlerFunc");
  const sig = handler?.type()?.underlying();
  if (sig?.$type !== "Signature") {
    return false;
  }
  const params = sig.params()!;
  const list = ft.params!.list;
  if (list.length !== params.len()) {
    return false;
  }
  return list.every((field, i) => types.identical(params.at(i)!.type(), pass.typesInfo.typeOf(field!.type!)));
}

export function isAssertionStmt(pass: AnyPass, stmt: ast.Stmt | null): boolean {
  return stmt?.$type === "ExprStmt" && stmt.x?.$type === "CallExpr" && newCallMeta(pass, stmt.x) !== null;
}

// FuncID identifies the function surrounding a node, as upstream's funcID.
export interface FuncID {
  key: string;
  isTestCleanup: boolean;
  isGoroutine: boolean;
  isHTTPHandler: boolean;
}

// findSurroundingFunc finds the innermost function enclosing the last node
// of stack.
export function findSurroundingFunc(pass: AnyPass, stack: ast.Node[]): FuncID | null {
  for (let i = stack.length - 2; i >= 0; i--) {
    const node = stack[i];
    let ft: ast.FuncType;
    let name: string;
    let isTestCleanup = false;
    let isGoroutine = false;
    let isHTTPHandler = false;
    if (node.$type === "FuncDecl") {
      ft = node.type!;
      name = node.name!.name;
      if (isSuiteMethod(pass, node) && isSuiteAfterTestMethod(name)) {
        isTestCleanup = true;
      }
      isHTTPHandler = mimicHTTPHandler(pass, ft);
    } else if (node.$type === "FuncLit") {
      ft = node.type!;
      name = "anonymous";
      isHTTPHandler = mimicHTTPHandler(pass, ft);
      const parent = i >= 2 ? stack[i - 1] : null;
      if (parent?.$type === "CallExpr") {
        const se = parent.fun;
        if (se?.$type === "SelectorExpr") {
          isTestCleanup = implementsTestingT(pass, se.x!) && se.sel !== null && se.sel.name === "Cleanup";
        }
        if (stack[i - 2].$type === "GoStmt") {
          isGoroutine = true;
        }
      }
    } else {
      continue;
    }
    const position = pass.fset.position(ft.pos());
    return {
      key: `${name} at ${position.filename}:${position.line}:${position.column} ${isTestCleanup} ${isGoroutine} ${isHTTPHandler}`,
      isTestCleanup,
      isGoroutine,
      isHTTPHandler,
    };
  }
  return null;
}

// nearest returns the nearest node of a type enclosing the last node of
// stack, and its index.
export function nearest<T extends ast.Node["$type"]>(stack: ast.Node[], type: T): [Extract<ast.Node, { $type: T }> | null, number] {
  for (let i = stack.length - 2; i >= 0; i--) {
    if (stack[i].$type === type) {
      return [stack[i] as Extract<ast.Node, { $type: T }>, i];
    }
  }
  return [null, 0];
}

// walkWithStack visits nodes of the given types in preorder with the stack of
// nodes enclosing them, ending with the node, as inspector.WithStack does.
// Returning false from visit skips a node's children.
export function walkWithStack<N extends ast.Node>(pass: AnyPass, types: TypeToken<N>[], visit: (node: N, stack: ast.Node[]) => boolean): void {
  pass.resultOf(inspect).withStack(types, (node, push, stack) => !push || visit(node as N, stack as ast.Node[]));
}
