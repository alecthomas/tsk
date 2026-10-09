import * as ast from "go/ast";
import * as constant from "go/constant";
import * as token from "go/token";
import type * as inspector from "golang.org/x/tools/go/ast/inspector";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";
import { unquote } from "./internal/strconv";

interface Config {
  /** Regular expressions of strings to ignore. */
  ignoreStringValues: string[];
  /** Mention an existing constant with the same value. */
  matchConstant: boolean;
  /** The shortest string to report. */
  minLen: number;
  /** The fewest occurrences to report. */
  minOccurrences: number;
  /** Also report repeated numbers. */
  numbers: boolean;
  /** Ignore integers below this, in numbers and strings that parse as integers. 0 disables. */
  min: number;
  /** Ignore integers above this, in numbers and strings that parse as integers. 0 disables. */
  max: number;
  /** Contexts to ignore literals in: assignment, binary, case, return, call, and compositelit. */
  excludeTypes: string[];
  /** Report constants with the same value as another. */
  findDuplicates: boolean;
  /** Evaluate constant expressions, as Prefix + "suffix", to match and find duplicates. */
  evalConstExpressions: boolean;
  /** Functions whose arguments are ignored, as println or slog.Info. */
  ignoreFunctions: string[];
  /** Ignore keys of map literals. */
  ignoreMapKeys: boolean;
  /** Ignore test files. */
  ignoreTests: boolean;
  /** Ignore call arguments; false with exclude-types = ["call"] checks them. */
  ignoreCalls: boolean;
}

interface Occurrence {
  pos: token.Pos;
  position: token.Position;
}

interface Const {
  name: string;
  pos: token.Pos;
  position: token.Position;
  // valueKey identifies the value, so "a" and `a` are one value.
  valueKey: string;
}

const testSuffix = "_test.go";

export default defineAnalyzer<Config>({
  name: "goconst",
  doc: `find repeated strings that could be replaced by a constant

Counts string literals in assignments, comparisons, cases, returns, calls,
and composite literals, separately in test and other files, and reports
each file with a string repeated at least min-occurrences times.`,
  requires: [inspect],
  config: {
    ignoreStringValues: [],
    matchConstant: true,
    minLen: 3,
    minOccurrences: 3,
    numbers: false,
    min: 3,
    max: 3,
    excludeTypes: ["call"],
    findDuplicates: false,
    evalConstExpressions: false,
    ignoreFunctions: [],
    ignoreMapKeys: false,
    ignoreTests: false,
    ignoreCalls: true,
  },
  run(pass) {
    new Collector(pass).run();
  },
});

class Collector {
  private readonly config: Pass<Config>["config"];
  private readonly ignore: RegExp | null;
  private readonly excluded: Set<string>;
  private readonly tokens: Set<token.Token>;
  private readonly kinds: Set<constant.Kind>;
  private readonly strings = new Map<string, Occurrence[]>();
  private readonly consts = new Map<string, Const[]>();

  constructor(private readonly pass: Pass<Config>) {
    const config = pass.config;
    this.config = config;
    const patterns = config.ignoreStringValues;
    this.ignore = patterns.length === 0 ? null : new RegExp(patterns.length === 1 ? patterns[0] : patterns.map((p) => `(${p})`).join("|"));
    // As golangci-lint, ignore-calls = false with only the default exclusion checks calls.
    const types = !config.ignoreCalls && config.excludeTypes.length === 1 && config.excludeTypes[0].toLowerCase() === "call" ? [] : config.excludeTypes;
    this.excluded = new Set(types.map((t) => t.toLowerCase()));
    this.tokens = new Set(config.numbers ? [token.STRING, token.INT, token.FLOAT] : [token.STRING]);
    this.kinds = new Set(config.numbers ? [constant.String, constant.Complex, constant.Float, constant.Int] : [constant.String]);
  }

  run(): void {
    for (const fileCursor of this.pass.resultOf(inspect).root().children()) {
      const file = fileCursor.node() as ast.File;
      if (this.config.ignoreTests && this.pass.fset.position(file.pos()).filename.endsWith(testSuffix)) {
        continue;
      }
      this.visitFile(fileCursor);
    }
    this.reportStrings();
    if (this.config.findDuplicates) {
      this.reportDuplicates();
    }
  }

  private visitFile(fileCursor: inspector.Cursor): void {
    // Map keys pruned by ignore-map-keys, which preorder visits after their literal.
    const skipped: ast.Node[] = [];
    const kinds = [ast.GenDecl, ast.AssignStmt, ast.BinaryExpr, ast.CaseClause, ast.ReturnStmt, ast.CallExpr, ast.CompositeLit];
    for (const cursor of fileCursor.preorder(...kinds)) {
      const node = cursor.node()!;
      if (skipped.some((s) => s.pos() <= node.pos() && node.end() <= s.end())) {
        continue;
      }
      this.visit(node, skipped);
    }
  }

  private visit(node: ast.Node, skipped: ast.Node[]): void {
    switch (node.$type) {
      case "GenDecl":
        if ((this.config.matchConstant || this.config.findDuplicates) && node.tok === token.CONST) {
          for (const spec of node.specs) {
            this.addConsts(spec as ast.ValueSpec);
          }
        }
        return;
      case "AssignStmt":
        for (const rhs of node.rhs) {
          this.addLiteral(rhs, "assignment");
        }
        return;
      case "BinaryExpr":
        if (node.op === token.EQL || node.op === token.NEQ) {
          this.addLiteral(node.x, "binary");
          this.addLiteral(node.y, "binary");
        }
        return;
      case "CaseClause":
        for (const item of node.list) {
          this.addLiteral(item, "case");
        }
        return;
      case "ReturnStmt":
        for (const item of node.results) {
          this.addLiteral(item, "return");
        }
        return;
      case "CallExpr":
        if (!this.ignoresCall(node)) {
          for (const arg of node.args) {
            this.addLiteral(arg, "call");
          }
        }
        return;
      case "CompositeLit": {
        const isMap = this.config.ignoreMapKeys && this.isMapLiteral(node);
        for (const element of node.elts) {
          this.addElement(element, isMap, skipped);
        }
        return;
      }
    }
  }

  private addConsts(spec: ast.ValueSpec): void {
    const info = this.pass.typesInfo;
    if (this.config.evalConstExpressions) {
      let added = false;
      for (const name of spec.names) {
        const object = info.defs.get(name!);
        const value = object?.$type === "Const" ? object.val() : null;
        if (value != null && this.kinds.has(value.kind())) {
          const [display, key] = constValueStrings(value);
          this.addConst(name!.name, display, name!.pos(), key);
          added = true;
        }
      }
      if (added || spec.values.length === 0) {
        return;
      }
      spec.values.forEach((expr, i) => {
        const value = info.types.get(expr!)?.value ?? null;
        if (value !== null && this.kinds.has(value.kind())) {
          const [display, key] = constValueStrings(value);
          this.addConst(spec.names[i]!.name, display, expr!.pos(), key);
        }
      });
      return;
    }
    spec.values.forEach((expr, i) => {
      if (expr?.$type === "BasicLit" && this.tokens.has(expr.kind)) {
        this.addConst(spec.names[i]!.name, expr.value, spec.names[i]!.pos(), "");
      }
    });
  }

  private addElement(element: ast.Expr | null, isMap: boolean, skipped: ast.Node[]): void {
    if (element?.$type === "BasicLit") {
      this.addLiteral(element, "compositelit");
      return;
    }
    if (element?.$type !== "KeyValueExpr") {
      return;
    }
    const key = element.key;
    if (key?.$type === "BasicLit") {
      // A string key can only be a map key, so it is ignored with ignore-map-keys.
      if (!this.config.ignoreMapKeys || key.kind !== token.STRING) {
        this.addLiteral(key, "compositelit");
      }
    } else if (this.config.ignoreMapKeys && isMap && key !== null) {
      skipped.push(key);
    }
    this.addLiteral(element.value, "compositelit");
  }

  private isMapLiteral(lit: ast.CompositeLit): boolean {
    const t = this.pass.typesInfo.types.get(lit)?.type ?? null;
    if (t !== null) {
      return t.underlying()?.$type === "Map";
    }
    return lit.type?.$type === "MapType";
  }

  private ignoresCall(call: ast.CallExpr): boolean {
    const fun = call.fun;
    const name = fun?.$type === "Ident" ? fun.name : fun?.$type === "SelectorExpr" && fun.x?.$type === "Ident" ? `${fun.x.name}.${fun.sel!.name}` : "";
    return name !== "" && this.config.ignoreFunctions.includes(name);
  }

  private addLiteral(expr: ast.Expr | null, context: string): void {
    if (expr?.$type !== "BasicLit" || !this.tokens.has(expr.kind) || this.excluded.has(context)) {
      return;
    }
    const str = unquoteOrStrip(expr.value);
    if (str.length === 0 || [...str].length < this.config.minLen || this.ignore?.test(str) || this.outOfRange(str)) {
      return;
    }
    const occurrences = this.strings.get(str) ?? [];
    occurrences.push({ pos: expr.pos(), position: this.pass.fset.position(expr.pos()) });
    this.strings.set(str, occurrences);
  }

  private addConst(name: string, value: string, pos: token.Pos, valueKey: string): void {
    const unquoted = unquoteOrStrip(value);
    if ([...unquoted].length < this.config.minLen || this.ignore?.test(unquoted)) {
      return;
    }
    const consts = this.consts.get(unquoted) ?? [];
    consts.push({ name, pos, position: this.pass.fset.position(pos), valueKey: valueKey === "" ? unquoted : valueKey });
    this.consts.set(unquoted, consts);
  }

  // outOfRange reports whether a string that parses as an integer, with Go's
  // base prefixes, falls outside min and max.
  private outOfRange(str: string): boolean {
    const { min, max } = this.config;
    if (min === 0 && max === 0) {
      return false;
    }
    const value = parseGoInt(str);
    return value !== null && ((min !== 0 && value < BigInt(min)) || (max !== 0 && value > BigInt(max)));
  }

  private reportStrings(): void {
    const minOccurrences = this.config.minOccurrences;
    for (const str of [...this.strings.keys()].sort()) {
      const positions = this.strings.get(str)!;
      if (positions.length < minOccurrences) {
        continue;
      }
      positions.sort((a, b) => comparePositions(a.position, b.position));
      const testCount = positions.filter((p) => p.position.filename.endsWith(testSuffix)).length;
      const nonTestCount = positions.length - testCount;
      let anyConst = "";
      let nonTestConst = "";
      if (this.config.matchConstant) {
        const consts = [...(this.consts.get(str) ?? [])].sort((a, b) => comparePositions(a.position, b.position));
        anyConst = consts[0]?.name ?? "";
        nonTestConst = consts.find((c) => !c.position.filename.endsWith(testSuffix))?.name ?? "";
      }
      const seen = new Set<string>();
      for (const occurrence of positions) {
        const filename = occurrence.position.filename;
        if (seen.has(filename)) {
          continue;
        }
        seen.add(filename);
        const isTest = filename.endsWith(testSuffix);
        const count = isTest ? testCount : nonTestCount;
        if (count < minOccurrences) {
          continue;
        }
        const matching = nonTestConst !== "" || !isTest ? nonTestConst : anyConst;
        const suffix = matching === "" ? ", make it a constant" : `, but such constant ${formatCode(matching)} already exists`;
        this.pass.report({ pos: occurrence.pos, message: `string ${formatCode(str)} has ${count} occurrences${suffix}` });
      }
    }
  }

  // reportDuplicates reports constants with the value of an earlier one,
  // comparing test and other constants separately.
  private reportDuplicates(): void {
    const groups = new Map<string, { display: string; consts: Const[] }>();
    for (const [display, consts] of this.consts) {
      for (const c of consts) {
        const group = groups.get(c.valueKey) ?? { display, consts: [] };
        if (display < group.display) {
          group.display = display;
        }
        group.consts.push(c);
        groups.set(c.valueKey, group);
      }
    }
    for (const key of [...groups.keys()].sort()) {
      const group = groups.get(key)!;
      if (group.consts.length < 2) {
        continue;
      }
      const isTest = (c: Const) => c.position.filename.endsWith(testSuffix);
      for (const scope of [group.consts.filter((c) => !isTest(c)), group.consts.filter(isTest)]) {
        scope.sort((a, b) => comparePositions(a.position, b.position));
        for (const duplicate of scope.slice(1)) {
          const first = scope[0];
          this.pass.report({ pos: duplicate.pos, message: `This constant is a duplicate of ${formatCode(first.name)} at ${positionString(first.position)}` });
        }
      }
    }
  }
}

function positionString(position: token.Position): string {
  return `${position.filename}:${position.line}:${position.column}`;
}

function comparePositions(a: token.Position, b: token.Position): number {
  if (a.filename !== b.filename) {
    return a.filename < b.filename ? -1 : 1;
  }
  return a.line - b.line || a.column - b.column;
}

function constValueStrings(value: constant.Value): [string, string] {
  if (value.kind() === constant.String) {
    return [value.exactString(), `string:${constant.stringVal(value)}`];
  }
  return [value.string(), `${constant.Kind.string(value.kind())}:${value.exactString()}`];
}

// unquoteOrStrip unquotes a Go string literal, or strips its quotes if it
// does not parse, as upstream does for truncated constant values.
function unquoteOrStrip(literal: string): string {
  const unquoted = unquote(literal);
  if (unquoted !== null || !literal.startsWith('"')) {
    return unquoted ?? literal;
  }
  return literal.length >= 2 ? literal.slice(1, -1) : literal;
}

// parseGoInt parses an integer as strconv.ParseInt with base 0 does, or
// returns null where it would fail.
function parseGoInt(text: string): bigint | null {
  const match = /^([+-]?)(0[xX](?:_?[0-9a-fA-F])+|0[bB](?:_?[01])+|0[oO](?:_?[0-7])+|0(?:_?[0-7])*|[1-9](?:_?[0-9])*)$/.exec(text);
  if (match === null) {
    return null;
  }
  let digits = match[2].split("_").join("");
  if (/^0[0-7]/.test(digits)) {
    digits = `0o${digits.slice(1)}`;
  }
  const value = BigInt(digits.replace(/^0[oO]/, "0o"));
  const signed = match[1] === "-" ? -value : value;
  const limit = BigInt("9223372036854775807");
  return signed > limit || signed < -limit - BigInt(1) ? null : signed;
}

// formatCode fences code in backquotes, unless it contains one itself.
function formatCode(code: string): string {
  const fence = "`";
  return code.includes(fence) ? code : fence + code + fence;
}
