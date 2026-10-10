import type * as ast from "go/ast";
import * as token from "go/token";
import { walk } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "string-format";

/** A check of the string literals passed to some functions. */
export interface Check {
  /** Comma-separated functions, each optionally with an argument index and field, such as "pkg.Func[1].Field". */
  scope: string;
  /** A regular expression between slashes that the strings must match, or, after "!", must not match. */
  regex: string;
  /** The failure message, instead of one naming the regular expression. */
  message?: string;
}

export interface Options {
  /** The checks to apply to string literals. */
  checks: Check[];
}

export const defaults: Options = { checks: [] };

interface Scope {
  funcName: string;
  argument: number;
  field: string;
}

interface Subrule {
  scopes: Scope[];
  regexp: RegExp;
  source: string;
  negated: boolean;
  errorMessage: string;
}

const identRegex = "[_A-Za-z][_A-Za-z0-9]*";
const parseScope = new RegExp(`^(${identRegex}(?:\\.${identRegex})?)(?:\\[([0-9]+)\\](?:\\.(${identRegex}))?)?$`);

export function create(options: DeepReadonly<Options>): Rule {
  const rules = options.checks.map((check, i) => parseCheck(check, i));
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      walk(
        {
          visit(node) {
            if (node === null || node.$type !== "CallExpr") {
              return this;
            }
            const call = node as ast.CallExpr;
            const callName = getCallName(call);
            if (callName === null) {
              return this;
            }
            for (const rule of rules) {
              for (const scope of rule.scopes) {
                if (scope.funcName === callName) {
                  applySubrule(rule, call, scope, failures);
                }
              }
            }
            return this;
          },
        },
        file.ast,
      );
      return failures;
    },
  };
}

function parseCheck(check: DeepReadonly<Check>, ruleNum: number): Subrule {
  if (check.scope === "") {
    throw configError("empty scope provided", ruleNum, 0);
  }
  if (check.regex.length < 2) {
    throw configError("regex is too small (regexes should begin and end with '/')", ruleNum, 1);
  }
  const scopes = check.scope.split(",").map((raw, scopeNum) => {
    const rawScope = raw.trim();
    if (rawScope === "") {
      throw parseScopeError("empty scope in rule scopes:", ruleNum, 0, scopeNum);
    }
    const matches = parseScope.exec(rawScope);
    if (matches === null) {
      throw parseScopeError("unable to parse rule scope", ruleNum, 0, scopeNum);
    }
    return { funcName: matches[1], argument: matches[2] ? Number(matches[2]) : 0, field: matches[3] ?? "" };
  });
  const negated = check.regex[0] === "!";
  const offset = negated ? 2 : 1;
  // Upstream strips the delimiters without checking that they are slashes.
  const source = check.regex.slice(offset, check.regex.length - 1);
  // Patterns are JavaScript regular expressions, where revive's are Go's.
  let regexp: RegExp;
  try {
    regexp = new RegExp(source);
  } catch {
    throw new Error(`failed to parse configuration for string-format: unable to compile ${check.regex} as regexp [argument ${ruleNum}, option 1]`);
  }
  return { scopes, regexp, source, negated, errorMessage: check.message ?? "" };
}

function configError(msg: string, ruleNum: number, option: number): Error {
  return new Error(`invalid configuration for string-format: ${msg} [argument ${ruleNum}, option ${option}]`);
}

function parseScopeError(msg: string, ruleNum: number, option: number, scopeNum: number): Error {
  return new Error(`failed to parse configuration for string-format: ${msg} [argument ${ruleNum}, option ${option}, scope index ${scopeNum}]`);
}

// getCallName names a call as Func, pkg.Func, or, for x.y.Func, y.Func.
function getCallName(call: ast.CallExpr): string | null {
  const fun = call.fun;
  if (fun === null) {
    return null;
  }
  if (fun.$type === "Ident") {
    return (fun as ast.Ident).name;
  }
  if (fun.$type === "SelectorExpr") {
    const selector = fun as ast.SelectorExpr;
    if (selector.x!.$type === "Ident") {
      return `${(selector.x as ast.Ident).name}.${selector.sel!.name}`;
    }
    if (selector.x!.$type === "SelectorExpr") {
      return `${(selector.x as ast.SelectorExpr).sel!.name}.${selector.sel!.name}`;
    }
  }
  return null;
}

function isString(node: ast.Node | null): node is ast.BasicLit {
  return node !== null && node.$type === "BasicLit" && (node as ast.BasicLit).kind === token.STRING;
}

function applySubrule(rule: Subrule, call: ast.CallExpr, scope: Scope, failures: Failure[]): void {
  if (call.args.length <= scope.argument) {
    return;
  }
  const arg = call.args[scope.argument]!;
  let lit: ast.BasicLit | null = null;
  if (scope.field !== "") {
    if (arg.$type !== "CompositeLit") {
      return;
    }
    for (const el of (arg as ast.CompositeLit).elts) {
      if (el!.$type !== "KeyValueExpr") {
        continue;
      }
      const kv = el as ast.KeyValueExpr;
      if (kv.key!.$type !== "Ident" || (kv.key as ast.Ident).name !== scope.field) {
        continue;
      }
      if (!isString(kv.value)) {
        return;
      }
      lit = kv.value;
    }
  } else {
    if (!isString(arg)) {
      return;
    }
    lit = arg;
  }
  if (lit === null) {
    return;
  }
  // Like upstream, strip the quotes without unescaping.
  const unquoted = lit.value.slice(1, lit.value.length - 1);
  const matches = rule.regexp.test(unquoted);
  if (rule.negated ? !matches : matches) {
    return;
  }
  let failure = rule.errorMessage;
  if (failure === "") {
    failure = rule.negated ? `string literal matches user defined regex /${rule.source}/` : `string literal doesn't match user defined regex /${rule.source}/`;
  }
  failures.push({ failure, confidence: 1, node: lit });
}
