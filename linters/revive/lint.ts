// Ports github.com/mgechev/revive's lint package (v1.17.0, MIT license): the
// file and package views rules see, and failures.

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
}

/** A rule, configured and created for one package. */
export interface Rule {
  readonly name: string;
  apply(file: File): Failure[];
}

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
    // Revive skips generated files entirely, so package-wide rules do not see
    // them. Unlike revive, which matches the marker on any line, they are
    // recognised by Go's convention, as tsk recognises them, without reading.
    this.files = [];
    for (const astFile of pass.files) {
      if (!ast.isGenerated(astFile)) {
        this.files.push(new File(this, astFile!, pass.fset.file(astFile!.fileStart)!.name()));
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

// Revive reports failures at least this confident, by default.
const confidence = 0.8;

/**
 * Runs one rule over the package's files and reports its failures. Unlike
 * revive, //revive: directives are not applied; //nolint comments are.
 */
export function runRule(pass: Pass<unknown>, rule: Rule): void {
  // Without a go.mod, revive assumes Go 1.0.
  const pkg = new Package(pass, pass.module?.goVersion || "1.0");
  for (const file of pkg.files) {
    for (const failure of rule.apply(file)) {
      if (failure.confidence < confidence) {
        continue;
      }
      const pos = failure.node?.pos() ?? failure.pos!;
      pass.report({ pos, end: failure.node?.end() ?? failure.end ?? pos, message: failure.failure });
    }
  }
}
