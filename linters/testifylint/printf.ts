// Checks of printf-style assertion messages, after testifylint's fork of go
// vet's printf pass. Copyright 2010 The Go Authors, BSD license.
import type * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import { type AnyPass, nodeString } from "./helpers";

const argBool = 1;
const argInt = 2;
const argRune = 4;
const argString = 8;
const argFloat = 16;
const argComplex = 32;
const argPointer = 64;
const argError = 128;
const anyType = -1;

const numFlag = " -+.0";
const sharpNumFlag = " -+.0#";
const allFlags = " -+.0#";

// printVerbs lists each verb's known flags and the argument types it takes.
const printVerbs: [string, string, number][] = [
  ["%", "", 0],
  ["b", sharpNumFlag, argInt | argFloat | argComplex | argPointer],
  ["c", "-", argRune | argInt],
  ["d", numFlag, argInt | argPointer],
  ["e", sharpNumFlag, argFloat | argComplex],
  ["E", sharpNumFlag, argFloat | argComplex],
  ["f", sharpNumFlag, argFloat | argComplex],
  ["F", sharpNumFlag, argFloat | argComplex],
  ["g", sharpNumFlag, argFloat | argComplex],
  ["G", sharpNumFlag, argFloat | argComplex],
  ["o", sharpNumFlag, argInt | argPointer],
  ["O", sharpNumFlag, argInt | argPointer],
  ["p", "-#", argPointer],
  ["q", " -+.0#", argRune | argInt | argString],
  ["s", " -+.0", argString],
  ["t", "-", argBool],
  ["T", "-", anyType],
  ["U", "-#", argRune | argInt],
  ["v", allFlags, anyType],
  ["w", allFlags, argError],
  ["x", sharpNumFlag, argRune | argInt | argString | argPointer | argFloat | argComplex],
  ["X", sharpNumFlag, argRune | argInt | argString | argPointer | argFloat | argComplex],
];

// FormatState is a parsed directive such as "%3.*[4]d".
interface FormatState {
  verb: string;
  format: string;
  flags: string;
  // argNums are the call arguments the directive consumes.
  argNums: number[];
  // argNum is the argument the parser reached, which the verb formats.
  argNum: number;
  hasIndex: boolean;
}

function count(n: number, what: string): string {
  return n === 1 ? `1 ${what}` : `${n} ${what}s`;
}

// checkPrintf checks a formatted assertion's arguments against its format,
// returning the problems found.
export function checkPrintf(pass: AnyPass, call: ast.CallExpr, fnName: string, format: string, formatIdx: number): string[] {
  const problems: string[] = [];
  const args = call.args as ast.Expr[];
  const firstArg = formatIdx + 1;
  if (!format.includes("%")) {
    if (args.length > firstArg) {
      problems.push(`${fnName} call has arguments but no formatting directives`);
    }
    return problems;
  }
  let argNum = firstArg;
  let maxArgNum = firstArg;
  let anyIndex = false;
  for (let i = 0; i < format.length; ) {
    if (format[i] !== "%") {
      i++;
      continue;
    }
    const state = parsePrintfVerb(problems, args, fnName, format.slice(i), firstArg, argNum);
    if (state === null) {
      return problems;
    }
    i += state.format.length;
    if (!okPrintfArg(pass, problems, call, fnName, state, firstArg)) {
      return problems;
    }
    anyIndex = anyIndex || state.hasIndex;
    if (state.verb === "w") {
      problems.push(`${fnName} does not support error-wrapping directive %w`);
      return problems;
    }
    if (state.argNums.length > 0) {
      argNum = state.argNums[state.argNums.length - 1] + 1;
    }
    for (const n of state.argNums) {
      maxArgNum = Math.max(maxArgNum, n + 1);
    }
  }
  if (call.ellipsis !== token.NoPos && maxArgNum >= args.length - 1) {
    return problems;
  }
  // With indexed formats, extra arguments are ignored.
  if (!anyIndex && maxArgNum !== args.length) {
    problems.push(`${fnName} call needs ${count(maxArgNum - firstArg, "arg")} but has ${count(args.length - firstArg, "arg")}`);
  }
  return problems;
}

function parsePrintfVerb(problems: string[], args: ast.Expr[], name: string, format: string, firstArg: number, startArgNum: number): FormatState | null {
  let n = 1;
  let flags = "";
  let argNum = startArgNum;
  const argNums: number[] = [];
  let hasIndex = false;
  let indexPending = false;
  const scanNum = () => {
    while (n < format.length && format[n] >= "0" && format[n] <= "9") {
      n++;
    }
  };
  const parseIndex = (): boolean => {
    if (n === format.length || format[n] !== "[") {
      return true;
    }
    n++;
    const start = n;
    scanNum();
    let ok = true;
    if (n === format.length || n === start || format[n] !== "]") {
      ok = false;
      const close = format.indexOf("]", start);
      if (close < 0) {
        problems.push(`${name} format ${format} is missing closing ]`);
        return false;
      }
      n = close;
    }
    const text = format.slice(start, n);
    const index = /^[+-]?\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!ok || Number.isNaN(index) || index > 0x7fffffff || index <= 0 || index > args.length - firstArg) {
      problems.push(`${name} format has invalid argument index [${text}]`);
      return false;
    }
    n++;
    argNum = index + firstArg - 1;
    hasIndex = true;
    indexPending = true;
    return true;
  };
  const parseNum = () => {
    if (n < format.length && format[n] === "*") {
      indexPending = false;
      n++;
      argNums.push(argNum);
      argNum++;
    } else {
      scanNum();
    }
  };
  while (n < format.length && "#0+- ".includes(format[n])) {
    flags += format[n++];
  }
  if (!parseIndex()) {
    return null;
  }
  parseNum();
  if (n < format.length && format[n] === ".") {
    flags += ".";
    n++;
    if (!parseIndex()) {
      return null;
    }
    parseNum();
  }
  if (!indexPending && !parseIndex()) {
    return null;
  }
  if (n === format.length) {
    problems.push(`${name} format ${format} is missing verb at end of string`);
    return null;
  }
  const verb = String.fromCodePoint(format.codePointAt(n)!);
  n += verb.length;
  if (verb !== "%") {
    argNums.push(argNum);
  }
  return { verb, format: format.slice(0, n), flags, argNums, argNum, hasIndex };
}

function okPrintfArg(pass: AnyPass, problems: string[], call: ast.CallExpr, name: string, state: FormatState, firstArg: number): boolean {
  const args = call.args as ast.Expr[];
  const found = printVerbs.find(([verb]) => verb === state.verb);
  const [, verbFlags, verbType] = found ?? printVerbs[printVerbs.length - 1];
  // An argument implementing fmt.Formatter accepts any verb and flags.
  let formatter = false;
  if (verbType !== argError && state.argNum < args.length) {
    const tv = pass.typesInfo.types.get(args[state.argNum]);
    formatter = tv?.type !== undefined && tv?.type !== null && isFormatter(tv.type);
  }
  if (!formatter) {
    if (found === undefined) {
      problems.push(`${name} format ${state.format} has unknown verb ${state.verb}`);
      return false;
    }
    for (const flag of state.flags) {
      // Go vet does not complain about '0'.
      if (flag !== "0" && !verbFlags.includes(flag)) {
        problems.push(`${name} format ${state.format} has unrecognized flag ${flag}`);
        return false;
      }
    }
  }
  const trueArgs = state.verb === "%" ? 0 : 1;
  for (let i = 0; i < state.argNums.length - trueArgs; i++) {
    if (!argCanBeChecked(problems, call, i, state, name, firstArg)) {
      // Upstream returns false here without saying so.
      return false;
    }
  }
  if (state.verb === "%" || formatter) {
    return true;
  }
  if (!argCanBeChecked(problems, call, state.argNums.length - 1, state, name, firstArg)) {
    return false;
  }
  const arg = args[state.argNums[state.argNums.length - 1]];
  const argType = pass.typesInfo.types.get(arg)?.type ?? null;
  if (argType?.$type === "Signature" && state.verb !== "p" && state.verb !== "T") {
    problems.push(`${name} format ${state.format} arg ${nodeString(pass, arg)} is a func value, not called`);
    return false;
  }
  if ((verbType & argString) !== 0 && state.verb !== "T" && !state.flags.includes("#")) {
    const method = recursiveStringer(pass, arg);
    if (method !== null) {
      problems.push(`${name} format ${state.format} with arg ${nodeString(pass, arg)} causes recursive ${method} method call`);
      return false;
    }
  }
  return true;
}

function argCanBeChecked(problems: string[], call: ast.CallExpr, formatArg: number, state: FormatState, name: string, firstArg: number): boolean {
  const argNum = state.argNums[formatArg];
  const nargs = call.args.length;
  if (argNum <= 0) {
    return false;
  }
  if (argNum < nargs - 1) {
    return true;
  }
  if (call.ellipsis !== token.NoPos) {
    return false;
  }
  if (argNum < nargs) {
    return true;
  }
  problems.push(`${name} format ${state.format} reads arg #${argNum - firstArg + 1}, but call has ${count(nargs - firstArg, "arg")}`);
  return false;
}

// isFormatter reports whether a type could satisfy fmt.Formatter.
function isFormatter(t: types.Type): boolean {
  // An interface value might hold a formatter, but a type parameter is not
  // assumed to.
  if (t.underlying()?.$type === "Interface" && types.unalias(t)?.$type !== "TypeParam") {
    return true;
  }
  const [object] = types.lookupFieldOrMethod(t, false, null, "Format");
  const sig = object?.$type === "Func" ? object.type() : null;
  if (sig?.$type !== "Signature" || sig.params()?.len() !== 2 || (sig.results()?.len() ?? 0) !== 0) {
    return false;
  }
  const state = types.unalias(sig.params()!.at(0)!.type());
  const isState = state?.$type === "Named" && state.obj()?.pkg()?.path() === "fmt" && state.obj()?.name() === "State";
  return isState && types.identical(sig.params()!.at(1)!.type(), types.Typ[types.Rune]);
}

// recursiveStringer returns the String or Error method an argument would
// call recursively, as t in "func (t T) String() string { ...("%s", t) }".
function recursiveStringer(pass: AnyPass, e: ast.Expr): string | null {
  const t = pass.typesInfo.types.get(e)?.type ?? null;
  if (t === null || isFormatter(t)) {
    return null;
  }
  const lookup = (methodName: string) => {
    const [object] = types.lookupFieldOrMethod(t, false, pass.pkg, methodName);
    return object?.$type === "Func" ? object : null;
  };
  const inScope = (fn: types.Func) => fn.scope()?.contains(e.pos()) ?? false;
  const str = lookup("String");
  const err = lookup("Error");
  let method: types.Func | null = null;
  if (str !== null && str.pkg() === pass.pkg && inScope(str)) {
    method = str;
  } else if (err !== null && err.pkg() === pass.pkg && inScope(err)) {
    method = err;
  } else {
    return null;
  }
  const sig = method.type();
  if (sig?.$type !== "Signature" || (sig.params()?.len() ?? 0) !== 0 || sig.results()?.len() !== 1 || sig.results()!.at(0)!.type() !== types.Typ[types.String]) {
    return null;
  }
  // The receiver r, or &r.
  const target = e.$type === "UnaryExpr" && e.op === token.AND ? e.x! : e;
  if (target.$type === "Ident" && pass.typesInfo.uses.get(target) === sig.recv()) {
    return method.fullName();
  }
  return null;
}
