import * as ast from "go/ast";
import * as token from "go/token";
import { unquote } from "../../internal/strconv";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "error-strings";

export interface Options {
  /** More functions whose message to check, each as pkg.Function. */
  customFunctions: string[];
}

export const defaults: Options = { customFunctions: [] };

const message = "error strings should not be capitalized or end with punctuation or a newline";

export function create(options: DeepReadonly<Options>): Rule {
  const functions = new Map<string, Set<string>>([
    ["fmt", new Set(["Errorf"])],
    ["errors", new Set(["Errorf", "WithMessage", "Wrap", "New", "WithMessagef", "Wrapf"])],
  ]);
  const invalid: string[] = [];
  for (const custom of options.customFunctions) {
    const trimmed = custom.trim();
    const dot = trimmed.indexOf(".");
    const pkg = trimmed.slice(0, dot);
    const fn = trimmed.slice(dot + 1);
    if (dot < 0 || pkg === "" || fn === "") {
      invalid.push(custom);
      continue;
    }
    const set = functions.get(pkg) ?? new Set<string>();
    functions.set(pkg, set.add(fn));
  }
  if (invalid.length !== 0) {
    throw new Error(`found invalid custom function: ${invalid.join(",")}`);
  }
  return {
    name,
    apply(file: File): Failure[] {
      const failures: Failure[] = [];
      ast.inspect(file.ast, (n) => {
        if (n === null || n.$type !== "CallExpr") {
          return true;
        }
        const call = n as ast.CallExpr;
        if (call.args.length < 1 || !matches(functions, call)) {
          return true;
        }
        const str = stringArg(call, 0) ?? (call.args.length < 2 ? null : stringArg(call, 1));
        if (str === null) {
          return true;
        }
        const s = unquote(str.value) ?? "";
        if (s === "") {
          return true;
        }
        const confidence = lintErrorString(s);
        if (confidence !== undefined) {
          failures.push({ node: str, confidence, failure: message });
        }
        return true;
      });
      return failures;
    },
  };
}

function matches(functions: Map<string, Set<string>>, call: ast.CallExpr): boolean {
  if (call.fun!.$type !== "SelectorExpr") {
    return false;
  }
  const sel = call.fun as ast.SelectorExpr;
  if (sel.x!.$type !== "Ident") {
    return false;
  }
  return functions.get((sel.x as ast.Ident).name)?.has(sel.sel!.name) ?? false;
}

function stringArg(call: ast.CallExpr, i: number): ast.BasicLit | null {
  const arg = call.args[i]!;
  return arg.$type === "BasicLit" && (arg as ast.BasicLit).kind === token.STRING ? (arg as ast.BasicLit) : null;
}

// unicode.IsSpace's set, which differs from JavaScript's \s.
const space = /[\t\n\v\f\r \u0085   -     　]/u;

// lintErrorString returns the failure's confidence, or undefined if s is clean.
function lintErrorString(s: string): number | undefined {
  const basicConfidence = 0.8;
  const capConfidence = basicConfidence - 0.2;
  const runes = [...s];
  const last = runes[runes.length - 1];
  if (last === "." || last === ":" || last === "!" || last === "\n") {
    return basicConfidence;
  }
  if (!/^\p{Lu}$/u.test(runes[0])) {
    return undefined;
  }
  // Proper nouns and exported identifiers lower the capitalisation confidence;
  // words with more capitals or digits, such as GitHub or I2000, are accepted.
  for (const r of runes.slice(1)) {
    if (space.test(r)) {
      break;
    }
    if (/^[\p{Lu}\p{Nd}]$/u.test(r)) {
      return undefined;
    }
  }
  return capConfidence;
}
