// testifylint's regular checkers, which each examine one assertion call.
import * as ast from "go/ast";
import * as token from "go/token";
import * as types from "go/types";
import type { Diagnostic, TextEdit } from "tsk";
import {
  type AnyPass,
  assertPkgPath,
  builtinLenArg,
  type CallMeta,
  callString,
  comparisonWith,
  errorType,
  fmtSprintfArgs,
  formatAsCallArgs,
  hasBoolType,
  hasBytesType,
  hasStringType,
  implementsError,
  implementsTestifySuite,
  intLiteral,
  isAnyZero,
  isBasicLit,
  isBoolOverride,
  isComparisonWithFloat,
  isEmptyInterface,
  isEmptyInterfaceType,
  isEmptyStringLit,
  isError,
  isFloat,
  isFunc,
  isIdentNamedAfterPattern,
  isIdentWithName,
  isNil,
  isObj,
  isOne,
  isPkgFnCall,
  isStringLit,
  isTypedConst,
  isUnsigned,
  isUntypedBool,
  isUntypedConst,
  isUntypedFalse,
  isUntypedTrue,
  isZero,
  isZeroOrSignedZero,
  negated,
  newDiagnostic,
  newRemoveFnAndUseDiagnostic,
  newRemoveFnDiagnostic,
  newRemoveLastArgTextEdit,
  newReplaceFnTextEdit,
  newSuggestedFuncReplacement,
  newUseFunctionDiagnostic,
  nodeString,
  objectOf,
  type Predicate,
  pointerElem,
  replaceWith,
  requirePkgPath,
  strictComparison,
  stringLiteral,
} from "./helpers";
import { checkPrintf } from "./printf";

export interface RegularChecker {
  name: string;
  check(pass: AnyPass, call: CallMeta): Diagnostic | null;
}

const equalFns = ["Equal", "EqualValues", "Exactly"];

export function floatCompare(): RegularChecker {
  const name = "float-compare";
  return {
    name,
    check(pass, call) {
      const args = call.args;
      let invalid = false;
      if (equalFns.includes(call.fn.nameFTrimmed)) {
        invalid = args.length > 1 && (isFloat(pass, args[0]) || isFloat(pass, args[1]));
      } else if (call.fn.nameFTrimmed === "True") {
        invalid = args.length > 0 && isComparisonWithFloat(pass, args[0], token.EQL);
      } else if (call.fn.nameFTrimmed === "False") {
        invalid = args.length > 0 && isComparisonWithFloat(pass, args[0], token.NEQ);
      }
      if (!invalid) {
        return null;
      }
      const message = call.fn.isFmt ? `use ${call.selectorXStr}.InEpsilonf (or InDeltaf)` : `use ${call.selectorXStr}.InEpsilon (or InDelta)`;
      return newDiagnostic(name, call.call, message);
    },
  };
}

export function boolCompare(ignoreCustomTypes: boolean): RegularChecker {
  const name = "bool-compare";
  return {
    name,
    check(pass, call) {
      // surviving renders the argument left after simplifying, cast to bool
      // for custom bool types, or returns null to skip those.
      const surviving = (arg: ast.Expr): string | null => {
        if (hasBoolType(pass, arg)) {
          return nodeString(pass, arg);
        }
        return ignoreCustomTypes ? null : `bool(${nodeString(pass, arg)})`;
      };
      const useFn = (proposed: string, arg: ast.Expr, start: token.Pos, end: token.Pos) => {
        const text = surviving(arg);
        return text === null ? null : newUseFunctionDiagnostic(name, call, proposed, { pos: start, end, newText: text });
      };
      const simplify = (arg: ast.Expr, start: token.Pos, end: token.Pos) => {
        const text = surviving(arg);
        if (text === null) {
          return null;
        }
        return newDiagnostic(name, call.call, "need to simplify the assertion", {
          message: "Simplify the assertion",
          textEdits: [{ pos: start, end, newText: text }],
        });
      };
      const args = call.args;
      const fn = call.fn.nameFTrimmed;
      if (equalFns.includes(fn) || fn === "NotEqual" || fn === "NotEqualValues") {
        if (args.length < 2) {
          return null;
        }
        const [a, b] = args;
        if (isEmptyInterface(pass, a) || isEmptyInterface(pass, b) || isBoolOverride(pass, a) || isBoolOverride(pass, b)) {
          return null;
        }
        const t1 = isUntypedTrue(pass, a);
        const t2 = isUntypedTrue(pass, b);
        const f1 = isUntypedFalse(pass, a);
        const f2 = isUntypedFalse(pass, b);
        const negate = fn === "NotEqual" || fn === "NotEqualValues";
        if (t1 !== t2 || f1 !== f2) {
          const isTrue = t1 !== t2;
          const arg = (isTrue ? t1 : f1) ? b : a;
          if (fn === "Exactly" && !hasBoolType(pass, arg)) {
            return null;
          }
          return useFn(isTrue !== negate ? "True" : "False", arg, a.pos(), b.end());
        }
        return null;
      }
      if (fn === "True" || fn === "False") {
        if (args.length < 1) {
          return null;
        }
        const expr = args[0];
        const same = comparisonWith(pass, expr, isUntypedTrue, token.EQL) ?? comparisonWith(pass, expr, isUntypedFalse, token.NEQ);
        if (same !== null && !isEmptyInterface(pass, same)) {
          return simplify(same, expr.pos(), expr.end());
        }
        const opposite = comparisonWith(pass, expr, isUntypedTrue, token.NEQ) ?? comparisonWith(pass, expr, isUntypedFalse, token.EQL) ?? negated(expr);
        if (opposite !== null && !isEmptyInterface(pass, opposite)) {
          return useFn(fn === "True" ? "False" : "True", opposite, expr.pos(), expr.end());
        }
      }
      return null;
    },
  };
}

export function empty(): RegularChecker {
  const name = "empty";
  const lenArg = (pass: AnyPass, e: ast.Expr) => builtinLenArg(pass, e);
  // lenAndZero returns x when a is len(x) and b is 0.
  const lenAndZero = (pass: AnyPass, a: ast.Expr, b: ast.Expr) => {
    const arg = lenArg(pass, a);
    return arg !== null && isZero(b) ? arg : null;
  };
  const checkEmpty = (pass: AnyPass, call: CallMeta): Diagnostic | null => {
    const use = (start: token.Pos, end: token.Pos, e: ast.Expr) => newUseFunctionDiagnostic(name, call, "Empty", replaceWith(pass, start, end, e));
    if (call.args.length === 0) {
      return null;
    }
    const a = call.args[0];
    switch (call.fn.nameFTrimmed) {
      case "Zero": {
        if (hasStringType(pass, a)) {
          return use(a.pos(), a.end(), a);
        }
        const arg = lenArg(pass, a);
        if (arg !== null) {
          return use(a.pos(), a.end(), arg);
        }
        break;
      }
      case "Empty": {
        const arg = lenArg(pass, a);
        if (arg !== null) {
          return newRemoveFnDiagnostic(pass, name, call, "len", a, arg);
        }
        break;
      }
    }
    if (call.args.length < 2) {
      return null;
    }
    const b = call.args[1];
    const fn = call.fn.nameFTrimmed;
    let arg: ast.Expr | null = null;
    if (fn === "Len") {
      return isZero(b) ? use(a.pos(), b.end(), a) : null;
    }
    if (equalFns.includes(fn)) {
      if (isEmptyStringLit(a)) {
        return use(a.pos(), b.end(), b);
      }
      arg = lenAndZero(pass, a, b) ?? lenAndZero(pass, b, a);
    } else if (fn === "LessOrEqual") {
      arg = isZero(b) ? lenArg(pass, a) : null;
    } else if (fn === "GreaterOrEqual") {
      arg = isZero(a) ? lenArg(pass, b) : null;
    } else if (fn === "Less") {
      arg = isOne(b) || isZero(b) ? lenArg(pass, a) : null;
    } else if (fn === "Greater") {
      arg = isOne(a) || isZero(a) ? lenArg(pass, b) : null;
    }
    return arg === null ? null : use(a.pos(), b.end(), arg);
  };
  const checkNotEmpty = (pass: AnyPass, call: CallMeta): Diagnostic | null => {
    const use = (start: token.Pos, end: token.Pos, e: ast.Expr) => newUseFunctionDiagnostic(name, call, "NotEmpty", replaceWith(pass, start, end, e));
    if (call.args.length === 0) {
      return null;
    }
    const a = call.args[0];
    switch (call.fn.nameFTrimmed) {
      case "Positive": {
        const arg = lenArg(pass, a);
        if (arg !== null) {
          return use(a.pos(), a.end(), arg);
        }
        break;
      }
      case "NotZero": {
        if (hasStringType(pass, a)) {
          return use(a.pos(), a.end(), a);
        }
        const arg = lenArg(pass, a);
        if (arg !== null) {
          return use(a.pos(), a.end(), arg);
        }
        break;
      }
      case "NotEmpty": {
        const arg = lenArg(pass, a);
        if (arg !== null) {
          return newRemoveFnDiagnostic(pass, name, call, "len", a, arg);
        }
        break;
      }
    }
    if (call.args.length < 2) {
      return null;
    }
    const b = call.args[1];
    const fn = call.fn.nameFTrimmed;
    let arg: ast.Expr | null = null;
    if (fn === "NotEqual" || fn === "NotEqualValues") {
      if (isEmptyStringLit(a)) {
        return use(a.pos(), b.end(), b);
      }
      arg = lenAndZero(pass, a, b) ?? lenAndZero(pass, b, a);
    } else if (fn === "Less") {
      arg = isZero(a) ? lenArg(pass, b) : null;
    } else if (fn === "Greater") {
      arg = isZero(b) ? lenArg(pass, a) : null;
    }
    return arg === null ? null : use(a.pos(), b.end(), arg);
  };
  return { name, check: (pass, call) => checkEmpty(pass, call) ?? checkNotEmpty(pass, call) };
}

export function negativePositive(): RegularChecker {
  const name = "negative-positive";
  const canBeNegative: Predicate = (pass, e) => !isUnsigned(pass, e) && !isZeroOrSignedZero(e) && builtinLenArg(pass, e) === null;
  const zeroOrSignedZero: Predicate = (_, e) => isZeroOrSignedZero(e);
  const anyZero: Predicate = (_, e) => isAnyZero(e);
  const notAnyZero: Predicate = (_, e) => !isAnyZero(e);
  // check proposes fn for "a < b", "b > a", and their True and False forms.
  const check = (
    pass: AnyPass,
    call: CallMeta,
    fn: string,
    small: Predicate,
    large: Predicate,
    survivor: "small" | "large",
    trueOps: [token.Token, token.Token],
    falseOps: [token.Token, token.Token],
  ): Diagnostic | null => {
    const use = (start: token.Pos, end: token.Pos, e: ast.Expr) => newUseFunctionDiagnostic(name, call, fn, replaceWith(pass, start, end, e));
    const args = call.args;
    switch (call.fn.nameFTrimmed) {
      case "Less":
        if (args.length >= 2 && small(pass, args[0]) && large(pass, args[1])) {
          return use(args[0].pos(), args[1].end(), survivor === "small" ? args[0] : args[1]);
        }
        return null;
      case "Greater":
        if (args.length >= 2 && large(pass, args[0]) && small(pass, args[1])) {
          return use(args[0].pos(), args[1].end(), survivor === "small" ? args[1] : args[0]);
        }
        return null;
      case "True":
      case "False": {
        if (args.length < 1) {
          return null;
        }
        const expr = args[0];
        const [op1, op2] = call.fn.nameFTrimmed === "True" ? trueOps : falseOps;
        const first = strictComparison(pass, expr, small, op1, large);
        const second = strictComparison(pass, expr, large, op2, small);
        const arg = first !== null ? first[survivor === "small" ? 0 : 1] : second !== null ? second[survivor === "small" ? 1 : 0] : null;
        return arg === null ? null : use(expr.pos(), expr.end(), arg);
      }
      default:
        return null;
    }
  };
  return {
    name,
    check(pass, call) {
      return (
        check(pass, call, "Negative", canBeNegative, zeroOrSignedZero, "small", [token.LSS, token.GTR], [token.GEQ, token.LEQ]) ??
        check(pass, call, "Positive", anyZero, notAnyZero, "large", [token.LSS, token.GTR], [token.GEQ, token.LEQ])
      );
    },
  };
}

const proposedInsteadOfTrue = new Map<token.Token, string>([
  [token.EQL, "Equal"],
  [token.NEQ, "NotEqual"],
  [token.GTR, "Greater"],
  [token.GEQ, "GreaterOrEqual"],
  [token.LSS, "Less"],
  [token.LEQ, "LessOrEqual"],
]);

const proposedInsteadOfFalse = new Map<token.Token, string>([
  [token.EQL, "NotEqual"],
  [token.NEQ, "Equal"],
  [token.GTR, "LessOrEqual"],
  [token.GEQ, "Less"],
  [token.LSS, "GreaterOrEqual"],
  [token.LEQ, "Greater"],
]);

export function compares(): RegularChecker {
  const name = "compares";
  return {
    name,
    check(pass, call) {
      const be = call.args[0];
      if (be?.$type !== "BinaryExpr") {
        return null;
      }
      const table = call.fn.nameFTrimmed === "True" ? proposedInsteadOfTrue : call.fn.nameFTrimmed === "False" ? proposedInsteadOfFalse : null;
      let proposed = table?.get(be.op);
      if (proposed === undefined) {
        return null;
      }
      if (pointerElem(pass, be.x!) !== null && pointerElem(pass, be.y!) !== null) {
        proposed = proposed === "Equal" ? "Same" : proposed === "NotEqual" ? "NotSame" : proposed;
      }
      return newUseFunctionDiagnostic(name, call, proposed, { pos: be.x!.pos(), end: be.y!.end(), newText: formatAsCallArgs(pass, be.x!, be.y!) });
    },
  };
}

export function contains(): RegularChecker {
  const name = "contains";
  return {
    name,
    check(pass, call) {
      if (call.args.length < 1) {
        return null;
      }
      const inner = negated(call.args[0]);
      const expr = inner ?? call.args[0];
      if (expr.$type !== "CallExpr" || expr.args.length !== 2 || !isPkgFnCall(pass, expr, "strings", "Contains")) {
        return null;
      }
      const isNeg = inner !== null;
      let proposed: string;
      if (call.fn.nameFTrimmed === "True") {
        proposed = isNeg ? "NotContains" : "Contains";
      } else if (call.fn.nameFTrimmed === "False") {
        proposed = isNeg ? "Contains" : "NotContains";
      } else {
        return null;
      }
      const arg = call.args[0];
      return newUseFunctionDiagnostic(name, call, proposed, { pos: arg.pos(), end: arg.end(), newText: formatAsCallArgs(pass, expr.args[0]!, expr.args[1]!) });
    },
  };
}

export function errorNil(): RegularChecker {
  const name = "error-nil";
  return {
    name,
    check(pass, call) {
      const args = call.args;
      let proposed: string | null = null;
      let surviving: ast.Expr | null = null;
      let end = token.NoPos;
      const fn = call.fn.nameFTrimmed;
      const single = (proposedFn: string) => {
        if (args.length >= 1 && isError(pass, args[0])) {
          [proposed, surviving, end] = [proposedFn, args[0], args[0].end()];
        }
      };
      const pair = (proposedFn: string) => {
        if (args.length < 2) {
          return;
        }
        const [a, b] = args;
        if (isError(pass, a) && isNil(b)) {
          [proposed, surviving, end] = [proposedFn, a, b.end()];
        } else if (isNil(a) && isError(pass, b)) {
          [proposed, surviving, end] = [proposedFn, b, b.end()];
        }
      };
      if (["Nil", "Empty", "Zero"].includes(fn)) {
        single("NoError");
      } else if (["NotNil", "NotEmpty", "NotZero"].includes(fn)) {
        single("Error");
      } else if ([...equalFns, "ErrorIs", "IsType"].includes(fn)) {
        pair("NoError");
      } else if (["NotEqual", "NotEqualValues", "NotErrorIs", "IsNotType"].includes(fn)) {
        pair("Error");
      }
      if (proposed === null || surviving === null) {
        return null;
      }
      return newUseFunctionDiagnostic(name, call, proposed, replaceWith(pass, args[0].pos(), end, surviving));
    },
  };
}

export function nilCompare(): RegularChecker {
  const name = "nil-compare";
  return {
    name,
    check(pass, call) {
      if (call.args.length < 2) {
        return null;
      }
      const [a, b] = call.args;
      if (isNil(a) === isNil(b)) {
        return null;
      }
      const surviving = isNil(a) ? b : a;
      const fn = call.fn.nameFTrimmed;
      const proposed = equalFns.includes(fn) ? "Nil" : fn === "NotEqual" || fn === "NotEqualValues" ? "NotNil" : null;
      return proposed === null ? null : newUseFunctionDiagnostic(name, call, proposed, replaceWith(pass, a.pos(), b.end(), surviving));
    },
  };
}

export function errorIsAs(): RegularChecker {
  const name = "error-is-as";
  // isAssertCollectT reports whether an expression is an *assert.CollectT.
  const isAssertCollectT = (pass: AnyPass, e: ast.Expr) => {
    const t = pass.typesInfo.typeOf(e);
    const elem = t?.$type === "Pointer" ? t.elem() : null;
    return elem?.$type === "Named" && elem.obj() === objectOf(pass.pkg, assertPkgPath, "CollectT");
  };
  const errorsCall = (pass: AnyPass, ce: ast.CallExpr, isFn: string, asFn: string) => {
    if (isPkgFnCall(pass, ce, "errors", "Is")) {
      return isFn;
    }
    return isPkgFnCall(pass, ce, "errors", "As") ? asFn : null;
  };
  return {
    name,
    check(pass, call) {
      const args = call.args;
      const sel = call.selectorXStr;
      switch (call.fn.nameFTrimmed) {
        case "Error":
          if (args.length >= 2 && isError(pass, args[1]) && !isAssertCollectT(pass, call.selector.x!)) {
            return newDiagnostic(name, call.call, `invalid usage of ${sel}.Error, use ${sel}.ErrorIs instead`, newSuggestedFuncReplacement(call, "ErrorIs"));
          }
          return null;
        case "NoError":
          if (args.length >= 2 && isError(pass, args[1])) {
            return newDiagnostic(name, call.call, `invalid usage of ${sel}.NoError, use ${sel}.NotErrorIs instead`, newSuggestedFuncReplacement(call, "NotErrorIs"));
          }
          return null;
        case "IsType":
        case "IsNotType": {
          // Upstream checks (len >= 2 && first is error) || second is error.
          if ((args.length >= 2 && isError(pass, args[0])) || (args.length >= 2 && isError(pass, args[1]))) {
            const not = call.fn.nameFTrimmed === "IsNotType" ? "Not" : "";
            return newDiagnostic(name, call.call, `use ${sel}.${not}ErrorIs or ${sel}.${not}ErrorAs depending on the case`);
          }
          return null;
        }
        case "True":
        case "False": {
          const ce = args[0];
          if (ce?.$type !== "CallExpr" || ce.args.length !== 2) {
            return null;
          }
          const proposed = call.fn.nameFTrimmed === "True" ? errorsCall(pass, ce, "ErrorIs", "ErrorAs") : errorsCall(pass, ce, "NotErrorIs", "NotErrorAs");
          if (proposed === null) {
            return null;
          }
          return newUseFunctionDiagnostic(name, call, proposed, { pos: ce.pos(), end: ce.end(), newText: formatAsCallArgs(pass, ce.args[0]!, ce.args[1]!) });
        }
        case "ErrorAs":
        case "NotErrorAs": {
          if (args.length < 2) {
            return null;
          }
          const target = args[1];
          if (isEmptyInterface(pass, target)) {
            return null;
          }
          const tv = pass.typesInfo.types.get(target);
          if (!tv) {
            return null;
          }
          const defaultReport = `second argument to ${callString(call)} must be a non-nil pointer to either a type that implements error, or to any interface type`;
          const pt = tv.type?.underlying();
          if (pt?.$type !== "Pointer") {
            return newDiagnostic(name, call.call, defaultReport);
          }
          const elem = pt.elem();
          if (elem === errorType) {
            return newDiagnostic(name, call.call, `second argument to ${callString(call)} should not be *error`);
          }
          if (elem?.underlying()?.$type !== "Interface" && !implementsError(elem)) {
            return newDiagnostic(name, call.call, defaultReport);
          }
          return null;
        }
        default:
          return null;
      }
    },
  };
}

const wordsRe = /[A-Z]+(?:[a-z]*|$)|[a-z]+/g;
const jsonIdentRe = /json|JSON|Json/;
const yamlWordRe = /yaml|YAML|Yaml|^(yml|YML|Yml)$/;

// isJSONLike reports whether a string, possibly quoted, looks like a JSON
// object or array of them.
function isJSONLike(s: string): boolean {
  let text = s.split('\\"').join('"');
  text = text.replace(/"+$/, "").replace(/^"+/, "");
  text = text.replace(/`+$/, "").replace(/^`+/, "");
  text = text.split("\n").join("").split("\\n").join("").split("\t").join("").split("\\t").join("").split(" ").join("");
  if (!["{{", "{[", '{"', "[{{", "[{[", '[{"'].some((prefix) => text.startsWith(prefix))) {
    return false;
  }
  return ['":{', '":[', '":"'].some((kv) => text.includes(kv));
}

function isJSONStyleExpr(pass: AnyPass, e: ast.Expr): boolean {
  if (isIdentNamedAfterPattern(jsonIdentRe, e)) {
    return hasBytesType(pass, e) || hasStringType(pass, e);
  }
  const tv = pass.typesInfo.types.get(e);
  if (tv?.value) {
    return isJSONLike(tv.value.string());
  }
  if (e.$type === "BasicLit") {
    return e.kind === token.STRING && isJSONLike(e.value);
  }
  const args = fmtSprintfArgs(pass, e);
  return args !== null && args.length > 0 && isJSONStyleExpr(pass, args[0]);
}

function isYAMLStyleExpr(pass: AnyPass, e: ast.Expr): boolean {
  return e.$type === "Ident" && (hasBytesType(pass, e) || hasStringType(pass, e)) && (e.name.match(wordsRe) ?? []).some((w) => yamlWordRe.test(w));
}

// formatWithStringCastForBytes renders an expression, converting bytes to a
// string, as buf.String() for a bytes.Buffer's Bytes().
function formatWithStringCastForBytes(pass: AnyPass, e: ast.Expr): string {
  if (!hasBytesType(pass, e)) {
    return nodeString(pass, e);
  }
  if (e.$type === "CallExpr" && e.fun?.$type === "SelectorExpr" && isIdentWithName("Bytes", e.fun.sel)) {
    const t = pass.typesInfo.typeOf(e.fun.x!);
    if (t !== null && t.string().replace(/^\*/, "") === "bytes.Buffer") {
      return `${nodeString(pass, e.fun.x!)}.String()`;
    }
  }
  return `string(${nodeString(pass, e)})`;
}

export function encodedCompare(): RegularChecker {
  const name = "encoded-compare";
  // unwrap strips conversions and string cleanup calls, reporting whether
  // the value was explicitly a json.RawMessage.
  const unwrap = (pass: AnyPass, e: ast.Expr): [ast.Expr, boolean] => {
    if (e.$type !== "CallExpr" || e.args.length === 0) {
      return [e, false];
    }
    const arg = e.args[0]!;
    if (isPkgFnCall(pass, e, "encoding/json", "RawMessage")) {
      // json.RawMessage(nil) is not explicit JSON.
      return isNil(arg) ? unwrap(pass, arg) : [unwrap(pass, arg)[0], true];
    }
    const fun = e.fun!;
    const isByteArray = fun.$type === "ArrayType" && isIdentWithName("byte", fun.elt);
    if (
      isIdentWithName("string", fun) ||
      isByteArray ||
      ["Replace", "ReplaceAll", "Trim", "TrimSpace"].some((fn) => isPkgFnCall(pass, e, "strings", fn))
    ) {
      return unwrap(pass, arg);
    }
    return [e, false];
  };
  return {
    name,
    check(pass, call) {
      if (!equalFns.includes(call.fn.nameFTrimmed) || call.args.length < 2) {
        return null;
      }
      const [lhs, rhs] = call.args;
      const [a, aJSON] = unwrap(pass, lhs);
      const [b, bJSON] = unwrap(pass, rhs);
      let proposed: string | null = null;
      if (aJSON || bJSON || isJSONStyleExpr(pass, a) || isJSONStyleExpr(pass, b)) {
        proposed = "JSONEq";
      } else if (isYAMLStyleExpr(pass, a) || isYAMLStyleExpr(pass, b)) {
        proposed = "YAMLEq";
      }
      if (proposed === null) {
        return null;
      }
      return newUseFunctionDiagnostic(
        name,
        call,
        proposed,
        { pos: lhs.pos(), end: lhs.end(), newText: formatWithStringCastForBytes(pass, a) },
        { pos: rhs.pos(), end: rhs.end(), newText: formatWithStringCastForBytes(pass, b) },
      );
    },
  };
}

export const defaultExpectedVarPattern = "(^(exp(ected)?|want(ed)?)([A-Z]\\w*)?$)|(^(\\w*[a-z])?(Exp(ected)?|Want(ed)?)$)";

const expectedActualFns = new Set([
  "Equal",
  "EqualExportedValues",
  "EqualValues",
  "Exactly",
  "InDelta",
  "InDeltaMapValues",
  "InDeltaSlice",
  "InEpsilon",
  "InEpsilonSlice",
  "IsNotType",
  "IsType",
  "JSONEq",
  "NotEqual",
  "NotEqualValues",
  "NotSame",
  "Same",
  "WithinDuration",
  "YAMLEq",
]);

const castableToExpected = new Set(["uint", "uint8", "uint16", "uint32", "uint64", "int", "int8", "int16", "int32", "int64", "float32", "float64", "rune", "string"]);

export function expectedActual(pattern: RegExp): RegularChecker {
  const name = "expected-actual";
  const isCandidate = (pass: AnyPass, expr: ast.Expr): boolean => {
    switch (expr.$type) {
      case "ParenExpr":
      case "StarExpr":
        return isCandidate(pass, expr.x!);
      case "UnaryExpr":
        if (expr.op === token.AND || expr.op === token.SUB) {
          return isCandidate(pass, expr.x!);
        }
        break;
      case "CompositeLit":
        return true;
      case "CallExpr": {
        const lenArg = builtinLenArg(pass, expr);
        if (lenArg !== null) {
          return isIdentNamedAfterPattern(pattern, lenArg);
        }
        return expr.fun?.$type === "ParenExpr" || isCastedBasicLitOrExpected(expr) || isExpectedValueFactory(pass, expr);
      }
    }
    return (
      isBasicLit(expr) ||
      isUntypedConst(pass, expr) ||
      isTypedConst(pass, expr) ||
      isIdentNamedAfterPattern(pattern, expr) ||
      (expr.$type === "SelectorExpr" && (isIdentNamedAfterPattern(pattern, expr.x) || isIdentNamedAfterPattern(pattern, expr.sel)))
    );
  };
  const isCastedBasicLitOrExpected = (ce: ast.CallExpr): boolean => {
    if (ce.args.length !== 1 || ce.fun?.$type !== "Ident") {
      return false;
    }
    if (ce.fun.name === "complex64" || ce.fun.name === "complex128") {
      return true;
    }
    return castableToExpected.has(ce.fun.name) && (isBasicLit(ce.args[0]!) || isIdentNamedAfterPattern(pattern, ce.args[0]));
  };
  const isExpectedValueFactory = (pass: AnyPass, ce: ast.CallExpr): boolean => {
    const fun = ce.fun;
    if (fun?.$type === "Ident") {
      return pattern.test(fun.name);
    }
    if (fun?.$type === "SelectorExpr") {
      const timeDate = objectOf(pass.pkg, "time", "Date");
      return (timeDate !== null && isObj(pass, fun.sel, timeDate)) || pattern.test(fun.sel!.name);
    }
    return false;
  };
  return {
    name,
    check(pass, call) {
      if (!expectedActualFns.has(call.fn.nameFTrimmed) || call.args.length < 2) {
        return null;
      }
      const [first, second] = call.args;
      if (!isCandidate(pass, second) || isCandidate(pass, first)) {
        return null;
      }
      return newDiagnostic(name, call.call, "need to reverse actual and expected values", {
        message: "Reverse actual and expected values",
        textEdits: [{ pos: first.pos(), end: second.end(), newText: formatAsCallArgs(pass, second, first) }],
      });
    },
  };
}

export function len(): RegularChecker {
  const name = "len";
  const checkArgs = (pass: AnyPass, call: CallMeta, a: ast.Expr, b: ast.Expr, inverted: boolean): Diagnostic | null => {
    const use = (lenArg: ast.Expr, expected: ast.Expr) => {
      const [start, end] = inverted ? [b.pos(), a.end()] : [a.pos(), b.end()];
      return newUseFunctionDiagnostic(name, call, "Len", { pos: start, end, newText: formatAsCallArgs(pass, lenArg, expected) });
    };
    const arg1 = builtinLenArg(pass, a);
    const arg2 = builtinLenArg(pass, b);
    if (arg2 !== null) {
      return use(arg2, a);
    }
    if (arg1 !== null && intLiteral(b) !== null) {
      return use(arg1, b);
    }
    return null;
  };
  return {
    name,
    check(pass, call) {
      if (equalFns.includes(call.fn.nameFTrimmed)) {
        return call.args.length < 2 ? null : checkArgs(pass, call, call.args[0], call.args[1], false);
      }
      if (call.fn.nameFTrimmed === "True") {
        const be = call.args[0];
        // In True, the actual value is usually first.
        return be?.$type === "BinaryExpr" && be.op === token.EQL ? checkArgs(pass, call, be.y!, be.x!, true) : null;
      }
      return null;
    },
  };
}

export function equalValues(): RegularChecker {
  const name = "equal-values";
  return {
    name,
    check(pass, call) {
      const fn = call.fn.nameFTrimmed;
      if ((fn !== "EqualValues" && fn !== "NotEqualValues") || call.args.length < 2) {
        return null;
      }
      const [first, second] = call.args;
      if (isFunc(pass, first) || isFunc(pass, second)) {
        return null;
      }
      const ft = pass.typesInfo.typeOf(first);
      const st = pass.typesInfo.typeOf(second);
      if (!types.identical(ft, st) || isEmptyInterfaceType(ft) || isEmptyInterfaceType(st)) {
        return null;
      }
      return newUseFunctionDiagnostic(name, call, fn.replace(/Values$/, ""));
    },
  };
}

export function regexp(): RegularChecker {
  const name = "regexp";
  return {
    name,
    check(pass, call) {
      const fn = call.fn.nameFTrimmed;
      const ce = call.args[0];
      if ((fn !== "Regexp" && fn !== "NotRegexp") || ce?.$type !== "CallExpr" || ce.args.length !== 1) {
        return null;
      }
      return isPkgFnCall(pass, ce, "regexp", "MustCompile") ? newRemoveFnDiagnostic(pass, name, call, "regexp.MustCompile", ce, ce.args[0]!) : null;
    },
  };
}

export function suiteExtraAssertCall(mode: "remove" | "require"): RegularChecker {
  const name = "suite-extra-assert-call";
  return {
    name,
    check(pass, call) {
      if (call.isPkg) {
        return null;
      }
      const x = call.selector.x;
      if (mode === "require") {
        // s.True
        if (x?.$type !== "Ident" || !implementsTestifySuite(pass, x)) {
          return null;
        }
        return newDiagnostic(name, call.call, `use an explicit ${nodeString(pass, x)}.Assert().${call.fn.name}`, {
          message: "Add `Assert()` call",
          textEdits: [{ pos: x.end(), end: x.end(), newText: ".Assert()" }],
        });
      }
      // s.Assert().True
      if (x?.$type !== "CallExpr" || x.fun?.$type !== "SelectorExpr") {
        return null;
      }
      const se = x.fun;
      if (!implementsTestifySuite(pass, se.x!) || se.sel?.name !== "Assert") {
        return null;
      }
      return newDiagnostic(name, call.call, `need to simplify the assertion to ${nodeString(pass, se.x!)}.${call.fn.name}`, {
        message: "Remove `Assert()` call",
        // One past the call removes the dot too.
        textEdits: [{ pos: se.sel.pos(), end: x.end() + 1, newText: "" }],
      });
    },
  };
}

export function suiteDontUsePkg(): RegularChecker {
  const name = "suite-dont-use-pkg";
  return {
    name,
    check(pass, call) {
      const args = call.argsRaw;
      if (!call.isPkg || args.length < 2) {
        return null;
      }
      const t = args[0];
      if (t.$type !== "CallExpr" || t.fun?.$type !== "SelectorExpr") {
        return null;
      }
      const se = t.fun;
      if (se.x === null || !implementsTestifySuite(pass, se.x) || se.sel?.name !== "T" || se.x.$type !== "Ident") {
        return null;
      }
      const selector = call.isAssert ? se.x.name : `${se.x.name}.Require()`;
      const x = call.selector.x!;
      return newDiagnostic(name, call.call, `use ${selector}.${call.fn.name}`, {
        message: `Replace \`${call.selectorXStr}\` with \`${selector}\``,
        textEdits: [
          { pos: x.pos(), end: x.end(), newText: selector },
          { pos: t.pos(), end: args[1].pos(), newText: "" },
        ],
      });
    },
  };
}

const sameVarFns = new Set([
  "Contains",
  "ElementsMatch",
  "Equal",
  "EqualExportedValues",
  "EqualValues",
  "ErrorAs",
  "ErrorIs",
  "Exactly",
  "Greater",
  "GreaterOrEqual",
  "Implements",
  "InDelta",
  "InDeltaMapValues",
  "InDeltaSlice",
  "InEpsilon",
  "InEpsilonSlice",
  "IsNotType",
  "IsType",
  "JSONEq",
  "Less",
  "LessOrEqual",
  "NotElementsMatch",
  "NotEqual",
  "NotEqualValues",
  "NotErrorAs",
  "NotErrorIs",
  "NotRegexp",
  "NotSame",
  "NotSubset",
  "Regexp",
  "Same",
  "Subset",
  "WithinDuration",
  "YAMLEq",
]);

export function uselessAssert(): RegularChecker {
  const name = "useless-assert";
  const canNotBeNegative = (pass: AnyPass, e: ast.Expr) => builtinLenArg(pass, e) !== null || isUnsigned(pass, e);
  const checkSameVars = (pass: AnyPass, call: CallMeta): Diagnostic | null => {
    const fn = call.fn.nameFTrimmed;
    let pair: [ast.Node, ast.Node] | null = null;
    if (sameVarFns.has(fn)) {
      pair = call.args.length < 2 ? null : [call.args[0], call.args[1]];
    } else if (fn === "True" || fn === "False") {
      const be = call.args[0];
      pair = be?.$type === "BinaryExpr" ? [be.x!, be.y!] : null;
    }
    if (pair !== null && nodeString(pass, pair[0]) === nodeString(pass, pair[1])) {
      return newDiagnostic(name, call.call, "asserting of the same variable");
    }
    return null;
  };
  const isMeaningless = (pass: AnyPass, call: CallMeta): boolean => {
    const args = call.args;
    const a = args[0];
    switch (call.fn.nameFTrimmed) {
      case "False":
      case "True":
        return args.length >= 1 && isUntypedBool(pass, a);
      case "GreaterOrEqual":
      case "Less":
        return args.length >= 2 && isAnyZero(args[1]) && canNotBeNegative(pass, a);
      case "Implements":
      case "NotImplements":
        return args.length >= 2 && isEmptyInterfaceType(pointerElem(pass, a)) && pointerElem(pass, a) !== null;
      case "LessOrEqual":
      case "Greater":
        return args.length >= 2 && isAnyZero(a) && canNotBeNegative(pass, args[1]);
      case "Positive":
        return args.length >= 1 && intLiteral(a) !== null;
      case "Negative":
        return args.length >= 1 && (intLiteral(a) !== null || canNotBeNegative(pass, a));
      case "Error":
      case "Nil":
      case "NoError":
      case "NotNil":
        return args.length >= 1 && isNil(a);
      case "Empty":
      case "NotEmpty":
        return args.length >= 1 && isStringLit(a);
      case "NotZero":
      case "Zero":
        return args.length >= 1 && (intLiteral(a) !== null || isStringLit(a) || isNil(a) || isUntypedBool(pass, a));
      default:
        return false;
    }
  };
  return {
    name,
    check(pass, call) {
      return checkSameVars(pass, call) ?? (isMeaningless(pass, call) ? newDiagnostic(name, call.call, "meaningless assertion") : null);
    },
  };
}

export interface FormatterOptions {
  checkFormatString: boolean;
  requireFFuncs: boolean;
  requireStringMsg: boolean;
}

export function formatter(options: FormatterOptions): RegularChecker {
  const name = "formatter";
  const checkNotFmt = (pass: AnyPass, call: CallMeta): Diagnostic | null => {
    const msgAndArgsPos = printfLikePosition(pass, call);
    if (msgAndArgsPos < 0) {
      return null;
    }
    const isSingle = msgAndArgsPos === call.argsRaw.length - 1;
    const msgAndArgs = call.argsRaw[msgAndArgsPos];
    if (call.fn.nameFTrimmed === "Fail" || call.fn.nameFTrimmed === "FailNow") {
      const failureMsg = stringLiteral(call.args[0]);
      if (failureMsg === null) {
        return null;
      }
      if (failureMsg.includes("%")) {
        return newDiagnostic(name, call.call, "failure message is not a format string, use msgAndArgs instead");
      }
    }
    const sprintfArgs = fmtSprintfArgs(pass, msgAndArgs);
    if (sprintfArgs !== null && isSingle) {
      if (options.requireFFuncs) {
        return newRemoveFnAndUseDiagnostic(pass, name, call, `${call.fn.name}f`, "fmt.Sprintf", msgAndArgs, ...sprintfArgs);
      }
      return newRemoveFnDiagnostic(pass, name, call, "fmt.Sprintf", msgAndArgs, ...sprintfArgs);
    }
    if (hasStringType(pass, msgAndArgs)) {
      if (stringLiteral(msgAndArgs) === "") {
        const fixes = isSingle ? [{ message: "Remove empty message", textEdits: [newRemoveLastArgTextEdit(pass, call.args)] }] : [];
        return newDiagnostic(name, call.call, "empty message", ...fixes);
      }
      return options.requireFFuncs ? newUseFunctionDiagnostic(name, call, `${call.fn.name}f`) : null;
    }
    if (!isSingle) {
      return newDiagnostic(name, call.call, "using msgAndArgs with non-string first element (msg) causes panic");
    }
    if (!options.requireStringMsg) {
      return null;
    }
    return newDiagnostic(name, call.call, "do not use non-string value as first element (msg) of msgAndArgs", {
      message: 'Introduce "%+v" as the message',
      textEdits: [{ pos: msgAndArgs.pos(), end: msgAndArgs.end(), newText: `"%+v", ${nodeString(pass, msgAndArgs)}` }],
    });
  };
  const checkFmt = (pass: AnyPass, call: CallMeta): Diagnostic | null => {
    const formatPos = msgPosition(call.fn.signature);
    if (formatPos < 0) {
      return null;
    }
    const msg = call.argsRaw[formatPos];
    const noFormatArgs = formatPos === call.argsRaw.length - 1;
    if (noFormatArgs) {
      const sprintfArgs = fmtSprintfArgs(pass, msg);
      if (sprintfArgs !== null) {
        return newRemoveFnDiagnostic(pass, name, call, "fmt.Sprintf", msg, ...sprintfArgs);
      }
    }
    const format = stringLiteral(msg);
    if (format === null) {
      return null;
    }
    if (format === "") {
      const edits: TextEdit[] = [newReplaceFnTextEdit(call.fn, call.fn.nameFTrimmed), newRemoveLastArgTextEdit(pass, call.args)];
      const fixes = noFormatArgs ? [{ message: `Remove empty message and use \`${call.fn.nameFTrimmed}\``, textEdits: edits }] : [];
      return newDiagnostic(name, call.call, "empty message", ...fixes);
    }
    if (!options.checkFormatString) {
      return null;
    }
    // Upstream keeps the last problem printf reports.
    const problems = checkPrintf(pass, call.call, callString(call), format, formatPos);
    return problems.length === 0 ? null : newDiagnostic(name, call.call, problems[problems.length - 1]);
  };
  return { name, check: (pass, call) => (call.fn.isFmt ? checkFmt(pass, call) : checkNotFmt(pass, call)) };
}

// printfLikePosition returns the index of a call's msgAndArgs, if it has an
// f-variant to suggest, or -1.
function printfLikePosition(pass: AnyPass, call: CallMeta): number {
  if (call.call.ellipsis !== token.NoPos) {
    return -1;
  }
  const pos = msgAndArgsPosition(call.fn.signature);
  if (pos <= 0 || pos >= call.argsRaw.length || !hasFormattedAnalogue(pass, call)) {
    return -1;
  }
  return pos;
}

function hasFormattedAnalogue(pass: AnyPass, call: CallMeta): boolean {
  const fName = `${call.fn.name}f`;
  if (objectOf(pass.pkg, assertPkgPath, fName) !== null || objectOf(pass.pkg, requirePkgPath, fName) !== null) {
    return true;
  }
  let recvType = call.fn.signature.recv()?.type() ?? null;
  if (recvType?.$type === "Pointer") {
    recvType = recvType.elem();
  }
  if (recvType?.$type !== "Named") {
    return false;
  }
  const named = recvType;
  return [...Array(named.numMethods()).keys()].some((i) => named.method(i)!.name() === fName);
}

function msgAndArgsPosition(sig: types.Signature): number {
  const params = sig.params();
  const n = params?.len() ?? 0;
  if (n < 1) {
    return -1;
  }
  const last = params!.at(n - 1)!;
  return last.name() === "msgAndArgs" && last.type()?.$type === "Slice" ? n - 1 : -1;
}

function msgPosition(sig: types.Signature): number {
  const params = sig.params();
  for (let i = 0; i < (params?.len() ?? 0); i++) {
    const param = params!.at(i)!;
    const t = param.type();
    // format covers assert.CollectT's Errorf.
    if (t?.$type === "Basic" && t.kind() === types.String && (param.name() === "msg" || param.name() === "format")) {
      return i;
    }
  }
  return -1;
}
