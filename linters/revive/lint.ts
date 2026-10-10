// Ports github.com/mgechev/revive's lint package (v1.17.0, MIT license): the
// file and package views rules see, failures, and //revive: directives.

import * as ast from "go/ast";
import type * as token from "go/token";
import * as types from "go/types";
import { formatNode, type Pass } from "tsk";
import { funcSignatureIs, receiverType } from "./astutils";

/** Options as rules receive them: frozen, as pass.config is. */
export type DeepReadonly<T> = T extends (infer E)[] ? readonly DeepReadonly<E>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/** A problem a rule found. */
export interface Failure {
  readonly failure: string;
  readonly confidence: number;
  /** The node the failure is about; its span is the failure's position. */
  readonly node?: ast.Node;
  /** The failure's span, when it has no node. */
  readonly pos?: token.Pos;
  readonly end?: token.Pos;
  /** Overrides the reporting rule's name, as directive failures do. */
  readonly ruleName?: string;
}

/** A rule, configured and created for one package. */
export interface Rule {
  readonly name: string;
  apply(file: File): Failure[];
}

// Revive skips generated files entirely, not only their findings, and
// recognises them by any line of the file, not only the header.
const generated = /^\/\/ Code generated .* DO NOT EDIT\.$/m;

/** The files of the package being linted, as a revive lint.Package. */
export class Package {
  readonly files: File[];
  private main: boolean | undefined;
  private sortableTypes: Set<string> | undefined;
  private readonly parsedGoVersion: number[];

  constructor(
    readonly pass: Pass<unknown>,
    /** The package's Go version, such as "1.22". */
    readonly goVersion: string,
  ) {
    this.parsedGoVersion = parseVersion(goVersion);
    this.files = [];
    for (const astFile of pass.files) {
      const name = pass.fset.file(astFile!.fileStart)!.name();
      const file = new File(this, astFile!, name);
      if (!generated.test(file.content())) {
        this.files.push(file);
      }
    }
  }

  isMain(): boolean {
    this.main ??= this.files.some((f) => f.ast.name!.name === "main");
    return this.main;
  }

  get typesPkg(): types.Package {
    return this.pass.pkg;
  }

  get typesInfo(): types.Info {
    return this.pass.typesInfo;
  }

  get fset(): token.FileSet {
    return this.pass.fset;
  }

  typeOf(expr: ast.Expr): types.Type | null {
    return this.pass.typesInfo.typeOf(expr);
  }

  /** Names of the package's types with Len, Less, and Swap methods. */
  sortable(): Set<string> {
    this.sortableTypes ??= scanSortable(this.files);
    return this.sortableTypes;
  }

  /** Reports whether the package's Go version is at least v, such as "1.22". */
  isAtLeastGoVersion(v: string): boolean {
    return compareVersions(this.parsedGoVersion, parseVersion(v)) >= 0;
  }
}

/** One file of the package being linted, as a revive lint.File. */
export class File {
  private text: string | undefined;

  constructor(
    readonly pkg: Package,
    readonly ast: ast.File,
    readonly name: string,
  ) {}

  isTest(): boolean {
    return this.name.endsWith("_test.go");
  }

  /** Whether other packages can import the file's symbols. */
  isImportable(): boolean {
    return !this.isTest() && !this.pkg.isMain();
  }

  /** The file's source. Token offsets count UTF-8 bytes, not string indices. */
  content(): string {
    this.text ??= this.pkg.pass.readFile(this.name);
    return this.text;
  }

  toPosition(pos: token.Pos): token.Position {
    return this.pkg.fset.position(pos);
  }

  /** The token.File of this file, for converting lines to positions. */
  tokenFile(): token.File {
    return this.pkg.fset.file(this.ast.fileStart)!;
  }

  /** Prints a node with its source layout, as go/printer does. */
  render(node: ast.Node): string {
    return formatNode(node, this.pkg.fset);
  }

  commentMap(): ast.CommentMap {
    return ast.newCommentMap(this.pkg.fset, this.ast, this.ast.comments);
  }

  /** The default type of expr if it is an untyped constant, out of context. */
  isUntypedConst(expr: ast.Expr): string | undefined {
    let tv: types.TypeAndValue;
    try {
      tv = types.eval_(this.pkg.fset, this.pkg.typesPkg, expr.pos(), this.render(expr));
    } catch {
      return undefined;
    }
    const t = tv.type;
    if (t !== null && t.$type === "Basic") {
      return untypedDefaults.get((t as types.Basic).kind());
    }
    return undefined;
  }
}

const untypedDefaults = new Map<types.BasicKind, string>([
  [types.UntypedBool, "bool"],
  [types.UntypedInt, "int"],
  [types.UntypedRune, "rune"],
  [types.UntypedFloat, "float64"],
  [types.UntypedComplex, "complex128"],
  [types.UntypedString, "string"],
]);

// parseVersion reads the numeric segments of a Go version, as
// hashicorp/go-version does for the versions go.mod holds.
function parseVersion(v: string): number[] {
  const match = /^v?(\d+(?:\.\d+)*)/.exec(v);
  return match === null ? [0] : match[1].split(".").map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

function scanSortable(files: File[]): Set<string> {
  const flags = new Map<string, number>();
  for (const file of files) {
    for (const decl of file.ast.decls) {
      if (decl!.$type !== "FuncDecl") {
        continue;
      }
      const fn = decl as ast.FuncDecl;
      if (fn.recv === null || fn.recv.list.length === 0) {
        continue;
      }
      const recv = receiverType(fn);
      flags.set(recv, (flags.get(recv) ?? 0) | sortableFlag(fn));
    }
  }
  return new Set([...flags].filter(([, f]) => f === 0b111).map(([name]) => name));
}

function sortableFlag(fn: ast.FuncDecl): number {
  if (funcSignatureIs(fn, "Len", [], ["int"])) {
    return 0b001;
  }
  if (funcSignatureIs(fn, "Less", ["int", "int"], ["bool"])) {
    return 0b010;
  }
  if (funcSignatureIs(fn, "Swap", ["int", "int"], [])) {
    return 0b100;
  }
  return 0;
}

/** Which //revive: directives must say why or what they disable. */
export interface Directives {
  readonly specifyDisableReason: boolean;
  readonly specifyDisableRule: boolean;
}

interface Interval {
  from: number;
  to: number;
}

const directiveRegexp = /^\/\/[\s]*revive:(enable|disable)(?:-(line|next-line))?(?::([^\s]+))?[\s]*(?: (.+))?$/;

/** A failure ready to report, with its rule and lines. */
export interface Reported {
  readonly ruleName: string;
  readonly failure: string;
  readonly pos: token.Pos;
  readonly end: token.Pos;
}

/**
 * Applies rules to file, dropping failures below confidence or in lines a
 * //revive: directive disables, and returns the rest with directive failures.
 */
export function lintFile(file: File, rules: Rule[], confidence: number, directives: Directives): Reported[] {
  const result: Reported[] = [];
  const intervals = disabledIntervals(file, rules, directives, result);
  for (const rule of rules) {
    for (const failure of rule.apply(file)) {
      const ruleName = failure.ruleName ?? rule.name;
      const pos = failure.node?.pos() ?? failure.pos!;
      const end = failure.node?.end() ?? failure.end ?? pos;
      if (failure.confidence >= confidence && !disabled(file, intervals.get(ruleName), pos, end)) {
        result.push({ ruleName, failure: failure.failure, pos, end });
      }
    }
  }
  return result;
}

function disabled(file: File, intervals: Interval[] | undefined, pos: token.Pos, end: token.Pos): boolean {
  if (intervals === undefined) {
    return false;
  }
  const start = file.toPosition(pos).line;
  const last = file.toPosition(end).line;
  return intervals.some((i) => (start >= i.from && start <= i.to) || (last >= i.from && last <= i.to));
}

function disabledIntervals(file: File, rules: Rule[], directives: Directives, failures: Reported[]): Map<string, Interval[]> {
  // Each rule's state changes, alternately disabling and enabling it.
  const changes = new Map<string, { enabled: boolean; line: number }[]>();
  // change records a state change for the rule and reports whether it changed
  // anything: a directive repeating the current state is a no-op.
  const change = (enabled: boolean, line: number, name: string): boolean => {
    const existing = changes.get(name) ?? [];
    changes.set(name, existing);
    const current = existing.length === 0 || existing[existing.length - 1].enabled;
    if (current === enabled) {
      return false;
    }
    existing.push({ enabled, line });
    return true;
  };
  for (const group of file.ast.comments) {
    const line = file.toPosition(group!.end()).line;
    for (const c of group!.list) {
      const match = directiveRegexp.exec(c!.text);
      if (match === null) {
        continue;
      }
      const [, directive, modifier, ruleList = "", reason = ""] = match;
      let names = ruleList
        .split(",")
        .map((name) => name.replace(/^\n+|\n+$/g, ""))
        .filter((name) => name !== "");
      const disabling = directive === "disable";
      if (disabling && directives.specifyDisableReason && reason.replace(/^ +| +$/g, "") === "") {
        failures.push({ ruleName: "specify-disable-reason", failure: "reason of lint disabling not found", pos: c!.pos(), end: c!.end() });
        continue;
      }
      if (disabling && directives.specifyDisableRule && names.length === 0) {
        failures.push({ ruleName: "specify-disable-rule", failure: "rule name for lint disabling not found", pos: c!.pos(), end: c!.end() });
        continue;
      }
      if (names.length === 0) {
        names = rules.map((r) => r.name);
      }
      const enabled = directive === "enable";
      for (const name of names) {
        switch (modifier) {
          case "line":
            if (change(enabled, line, name)) {
              change(!enabled, line, name);
            }
            break;
          case "next-line":
            if (change(enabled, line + 1, name)) {
              change(!enabled, line + 1, name);
            }
            break;
          default:
            change(enabled, line, name);
        }
      }
    }
  }
  const result = new Map<string, Interval[]>();
  for (const [name, list] of changes) {
    const intervals: Interval[] = [];
    list.forEach(({ line }, i) => {
      if (i % 2 === 0) {
        intervals.push({ from: line, to: 2 ** 31 - 1 });
      } else {
        intervals[intervals.length - 1].to = line;
      }
    });
    result.set(name, intervals);
  }
  return result;
}
