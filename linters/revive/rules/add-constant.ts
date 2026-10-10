import type * as ast from "go/ast";
import * as token from "go/token";
import { type Visitor, walk } from "../astutils";
import type { DeepReadonly, Failure, File, Rule } from "../lint";

export const name = "add-constant";

export interface Options {
  /** Float literals allowed as written, such as "0.0". */
  allowFloats: string[];
  /** Integer literals allowed as written, such as "0x10". */
  allowInts: string[];
  /** String literals allowed as written, quotes included, such as "\"\"". */
  allowStrs: string[];
  /** How many times a string literal may appear before it is reported. */
  maxLitCount: number;
  /** Regular expressions matching calls, such as "os\\.Chmod", whose literal arguments are allowed. */
  ignoreFuncs: string[];
}

export const defaults: Options = { allowFloats: [], allowInts: [], allowStrs: [], maxLitCount: 2, ignoreFuncs: [] };

interface Config {
  allowed: Map<token.Token, Set<string>>;
  ignoreFuncs: RegExp[];
  strLitLimit: number;
}

export function create(options: DeepReadonly<Options>): Rule {
  if (!Number.isInteger(options.maxLitCount)) {
    throw new Error(`invalid argument to the add-constant rule, expecting string representation of an integer. Got '${options.maxLitCount}'`);
  }
  // Patterns are JavaScript regular expressions, where revive's are Go's.
  const ignoreFuncs = options.ignoreFuncs.map((pattern) => {
    const exclude = pattern.replace(/^ +| +$/g, "");
    if (exclude === "") {
      throw new Error("invalid argument to the ignoreFuncs parameter of add-constant rule, expected regular expression must not be empty");
    }
    try {
      return new RegExp(exclude);
    } catch (e) {
      throw new Error(`invalid argument to the ignoreFuncs parameter of add-constant rule: regexp "${exclude}" does not compile: ${e}`);
    }
  });
  const config: Config = {
    allowed: new Map([
      [token.INT, new Set(options.allowInts)],
      [token.FLOAT, new Set(options.allowFloats)],
      [token.STRING, new Set(options.allowStrs)],
    ]),
    ignoreFuncs,
    strLitLimit: options.maxLitCount,
  };
  return {
    name,
    apply(file: File): Failure[] {
      const visitor = new LiteralVisitor(config);
      walk(visitor, file.ast);
      return visitor.failures;
    },
  };
}

// Revive skips declarations, and checks only the literal arguments of calls,
// not other expressions inside them.
class LiteralVisitor implements Visitor {
  readonly failures: Failure[] = [];
  // Counts of each string literal, or -1 once reported.
  private readonly strLits = new Map<string, number>();
  private readonly structTags = new Set<ast.BasicLit>();

  constructor(private readonly config: Config) {}

  visit(node: ast.Node | null): Visitor | null {
    if (node === null) {
      return null;
    }
    switch (node.$type) {
      case "CallExpr":
        this.checkFunc(node as ast.CallExpr);
        return null;
      case "GenDecl":
        return null;
      case "BasicLit":
        if (!this.structTags.has(node as ast.BasicLit)) {
          this.checkLit(node as ast.BasicLit);
        }
        break;
      case "StructType": {
        const fields = (node as ast.StructType).fields;
        for (const field of fields?.list ?? []) {
          if (field!.tag !== null) {
            this.structTags.add(field!.tag);
          }
        }
        break;
      }
    }
    return this;
  }

  private checkFunc(expr: ast.CallExpr): void {
    const fName = funcName(expr);
    for (const arg of expr.args) {
      if (arg!.$type === "CallExpr") {
        this.checkFunc(arg as ast.CallExpr);
      } else if (arg!.$type === "BasicLit" && !this.config.ignoreFuncs.some((re) => re.test(fName))) {
        this.checkLit(arg as ast.BasicLit);
      }
    }
  }

  private checkLit(n: ast.BasicLit): void {
    switch (n.kind) {
      case token.INT:
      case token.FLOAT:
        if (!this.config.allowed.get(n.kind)!.has(n.value)) {
          this.failures.push({ failure: `avoid magic numbers like '${n.value}', create a named constant for it`, node: n, confidence: 1 });
        }
        break;
      case token.STRING:
        this.checkStrLit(n);
        break;
    }
  }

  private checkStrLit(n: ast.BasicLit): void {
    if (this.config.allowed.get(token.STRING)!.has(n.value)) {
      return;
    }
    const count = this.strLits.get(n.value) ?? 0;
    if (count < 0) {
      return;
    }
    this.strLits.set(n.value, count + 1);
    if (isEmptyString(n.value)) {
      return;
    }
    if (count + 1 > this.config.strLitLimit) {
      this.failures.push({ failure: `string literal ${n.value} appears, at least, ${count + 1} times, create a named constant for it`, node: n, confidence: 1 });
      this.strLits.set(n.value, -1);
    }
  }
}

function funcName(expr: ast.CallExpr): string {
  const fun = expr.fun!;
  if (fun.$type === "Ident") {
    return (fun as ast.Ident).name;
  }
  if (fun.$type === "SelectorExpr") {
    const sel = fun as ast.SelectorExpr;
    if (sel.x!.$type === "Ident") {
      return `${(sel.x as ast.Ident).name}.${sel.sel!.name}`;
    }
    // A method of a call's result, such as fn().Info, is named ".Info".
    if (sel.x!.$type === "CallExpr") {
      return `.${sel.sel!.name}`;
    }
  }
  return "";
}

// isEmptyString reports whether a string literal's value is empty; raw
// strings drop carriage returns.
function isEmptyString(lit: string): boolean {
  if (lit.startsWith("`")) {
    return lit.slice(1, -1).replace(/\r/g, "") === "";
  }
  return lit === `""`;
}
