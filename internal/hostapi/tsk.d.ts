// The tsk script API. Analyzers mirror golang.org/x/tools/go/analysis.

// Console output goes to tsk's log at the matching level; console.log
// is info. Lines from a run are tagged with its analyzer and package.
declare var console: {
  debug(...values: unknown[]): void;
  log(...values: unknown[]): void;
  info(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
};

declare module "tsk" {
  import type * as ast from "go/ast";
  import type * as token from "go/token";
  import type * as types from "go/types";

  /** A single-use iterator over a Go sequence, fetched from Go in batches. */
  export interface GoIterable<T> extends IteratorObject<T, undefined, unknown> {
    /** Keeps matching elements in Go, if iteration has not started. */
    filter(predicate: NativePredicate<T>): GoIterable<T>;
    filter<S extends T>(predicate: (value: T, index: number) => value is S): IteratorObject<S, undefined, unknown>;
    filter(predicate: (value: T, index: number) => unknown): IteratorObject<T, undefined, unknown>;
  }

  /** A function implemented in Go; filtering with it never calls JavaScript per element. */
  export interface NativePredicate<T> {
    (value: T): boolean;
    readonly $native: true;
  }

  export type Predicate<T> = NativePredicate<T> | ((value: T) => boolean);

  /** Combines predicates; the result is native when every operand is. */
  export function and<T>(...predicates: Predicate<T>[]): Predicate<T>;
  export function or<T>(...predicates: Predicate<T>[]): Predicate<T>;
  export function not<T>(predicate: Predicate<T>): Predicate<T>;
  /**
   * Formats a syntax node with go/format. Without a file set the node prints
   * on one line; with pass.fset it keeps its source layout.
   */
  export function formatNode(node: ast.Node, fset?: token.FileSet): string;

  /** A read-only view of a Go map. Keys keep Go identity. */
  export interface MapView<K, V> extends Iterable<[K, V]> {
    readonly size: number;
    get(key: K): V | undefined;
    has(key: K): boolean;
    keys(): K[];
    values(): V[];
    entries(): [K, V][];
  }

  /**
   * A Go error thrown by a Go function. Error variables such as os.ErrNotExist
   * are subclasses matched as errors.Is matches them. Error types such as
   * fs.PathError are subclasses whose fields are readable, as errors.As finds
   * the first in the wrap chain.
   */
  export class GoError extends Error {
    protected constructor();
  }

  /** Stands for a typed nil of T, as Go passes (*ast.Ident)(nil) to select node types. */
  export interface TypeToken<T> {
    readonly $token: T;
  }

  interface NoConfig {
    readonly [key: string]: never;
  }

  type DeepReadonly<T> = T extends (infer E)[] ? readonly DeepReadonly<E>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

  // config is required only when the config type has a required property, and
  // NoInfer stops TypeScript inferring the config type from the defaults.
  // biome-ignore lint/complexity/noBannedTypes: {} extends C tests that C has no required property.
  type ConfigProperty<C> = {} extends C ? { readonly config?: NoInfer<C> } : { readonly config: NoInfer<C> };

  export interface AnalyzerDefinition<C> {
    /** A Go identifier, also the name of the analyzer's table in .tsk/config.toml. */
    readonly name: string;
    readonly doc: string;
    readonly url?: string;
    readonly requires?: readonly (Analyzer | HostAnalyzer<unknown>)[];
    /** Every fact this analyzer imports or exports. A fact belongs to one analyzer. */
    readonly facts?: readonly Fact<unknown>[];
    readonly runDespiteErrors?: boolean;
    /**
     * Where the analyzer runs. "module", the default, runs it only on packages
     * of the module being linted. "all" also runs it on every dependency, as
     * go/analysis does, for analyzers that need facts about dependencies.
     */
    readonly scope?: "module" | "all";
    /**
     * Whether the analyzer reports findings in _test.go files. Set false for
     * linters whose rules do not apply to tests. Defaults to true.
     */
    readonly tests?: boolean;
    /** Returns the result other analyzers read with resultOf; it must be JSON. */
    run(pass: Pass<C>): unknown;
  }

  export interface Analyzer {
    readonly name: string;
  }

  /** An analyzer implemented in Go, exported by "tsk/passes". */
  export interface HostAnalyzer<R> {
    readonly name: string;
    readonly $result: R;
  }

  /** Declares an analyzer. Pass the config type explicitly when there is one. */
  export function defineAnalyzer<C extends object = NoConfig>(definition: AnalyzerDefinition<C> & ConfigProperty<C>): Analyzer;

  /** A fact handle. Values must be JSON and must not depend on config. */
  export interface Fact<T> {
    readonly name: string;
    readonly $value: T;
  }

  export function defineFact<T>(name: string): Fact<T>;

  export interface Module {
    readonly path: string;
    readonly version: string;
    readonly goVersion: string;
  }

  export interface TextEdit {
    readonly pos: token.Pos;
    readonly end: token.Pos;
    readonly newText: string;
  }

  export interface SuggestedFix {
    readonly message: string;
    readonly textEdits: readonly TextEdit[];
  }

  export interface RelatedInformation {
    readonly pos: token.Pos;
    readonly end?: token.Pos;
    readonly message: string;
  }

  export interface Diagnostic {
    readonly pos: token.Pos;
    readonly end?: token.Pos;
    readonly category?: string;
    readonly message: string;
    readonly url?: string;
    readonly suggestedFixes?: readonly SuggestedFix[];
    readonly related?: readonly RelatedInformation[];
  }

  export interface ObjectFact<T> {
    readonly object: types.Object;
    readonly fact: Fact<T>;
    readonly value: T;
  }

  export interface PackageFact<T> {
    readonly package: types.Package;
    readonly fact: Fact<T>;
    readonly value: T;
  }

  /** One analyzer's view of one package, mirroring analysis.Pass. */
  export interface Pass<C> {
    readonly analyzer: Analyzer;
    readonly fset: token.FileSet;
    readonly files: readonly ast.File[];
    readonly otherFiles: readonly string[];
    readonly ignoredFiles: readonly string[];
    readonly pkg: types.Package;
    readonly typesInfo: types.Info;
    readonly typesSizes: types.Sizes | null;
    readonly typeErrors: readonly types.Error[];
    readonly module: Module | undefined;
    readonly config: DeepReadonly<C>;
    report(diagnostic: Diagnostic): void;
    resultOf<R>(analyzer: HostAnalyzer<R>): R;
    resultOf(analyzer: Analyzer): unknown;
    /** Reads a file of this package, as analysis.Pass.ReadFile permits. */
    readFile(filename: string): string;
    importObjectFact<T>(object: types.Object, fact: Fact<T>): T | undefined;
    exportObjectFact<T>(object: types.Object, fact: Fact<T>, value: T): void;
    importPackageFact<T>(pkg: types.Package, fact: Fact<T>): T | undefined;
    exportPackageFact<T>(fact: Fact<T>, value: T): void;
    allObjectFacts(): ObjectFact<unknown>[];
    allPackageFacts(): PackageFact<unknown>[];
  }
}

declare module "tsk/passes" {
  import type * as buildssaPass from "golang.org/x/tools/go/analysis/passes/buildssa";
  import type * as ctrlflowPass from "golang.org/x/tools/go/analysis/passes/ctrlflow";
  import type * as inspector from "golang.org/x/tools/go/ast/inspector";
  import type { HostAnalyzer } from "tsk";

  export const inspect: HostAnalyzer<inspector.Inspector>;
  /** The package in SSA form, and its functions declared in source. */
  export const buildssa: HostAnalyzer<buildssaPass.SSA>;
  /** The control-flow graph of each function in the package. */
  export const ctrlflow: HostAnalyzer<ctrlflowPass.CFGs>;
}

declare module "go/types" {
  import type * as ast from "go/ast";
  import type * as inspector from "golang.org/x/tools/go/ast/inspector";
  import type { NativePredicate } from "tsk";

  interface Info {
    /** Reports whether the node is the predeclared nil. Accepts cursors. */
    readonly isNil: NativePredicate<ast.Node | inspector.Cursor>;
    /** Reports whether the node denotes a type. Accepts cursors. */
    readonly isType: NativePredicate<ast.Node | inspector.Cursor>;
  }
}
