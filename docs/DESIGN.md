# Tsk Tsk design

## Summary

`tsk` hosts `go/analysis` analyzers written in TypeScript. Scripts are
type-checked and transpiled with the Go TypeScript compiler through a shim
module, run in sobek, and bound to the real `go/analysis` machinery. Every
script analyzer is a genuine `*analysis.Analyzer`, so it runs unchanged under
the `tsk` driver and `analysistest`, with facts, config, `Requires`,
and results all working.

Scripts load from a `.tsk` directory found by walking up from the
working directory, and from TypeScript sources compiled into the binary. Each
analyzer may declare a typed config, populated from `.tsk.toml`.

The ported `optionalnil` and `encapsulation` linters in `linters/` are the
acceptance tests. They pass their original fixtures and report exactly what the
Go linters report on real repositories.

The core decisions:

1. **Generated declarations and registry, reflective wrapping.** A generator
   reads the exported API of a fixed package list and emits a Go registry of
   package members plus matching `.d.ts` files. A hand-written bridge wraps
   values by reflection with uniform conversion rules.
2. **A pool of named fact types.** `go/analysis` needs a distinct pointer type
   with methods per fact. Each `(analyzer, fact)` pair is assigned one of 256
   pre-declared types.
3. **Go-side predicates and chunked batches.** Traversals accept native Go
   predicates and deliver results in batches as native JavaScript arrays, so
   hot loops cross the VM boundary only for matches.
4. **One runtime per worker, one wrapper cache per pass.** Sobek is
   single-threaded and the checker is concurrent, so runtimes are pooled. Go
   values are wrapped once per pass so JavaScript identity matches Go identity.

## Verified constraints

These were checked in the module cache and toolchain source rather than
assumed.

- **tsgo access works via the shim trick.** `internal/typescript` claims the
  path `github.com/microsoft/TypeScript/tsc/shim/typescript` with a `replace`
  directive, which lets it import the compiler's internal packages.
  Transpilation emits inline source maps, which sobek reads, so script stack
  traces point at `.ts` lines.
- **sobek reflection is not enough on its own.** `Runtime.toValue` allocates a
  fresh wrapper for every Go pointer with no identity cache, so JavaScript
  `Map` and `Set` keys would not work. Sobek has no hook for a type
  discriminator, which TypeScript needs to narrow `types.Type` or `ast.Node`.
  Go `iter.Seq` values and maps keyed by pointers have no useful mapping.
- **Fact types cannot be created at runtime.** `go/analysis` requires a
  distinct pointer fact type with methods per fact, keyed by type.
  `reflect.PointerTo` of a `reflect.StructOf` type has no methods, so it
  cannot implement `analysis.Fact`.
- **`analysistest.Run` takes an interface**, `Testing { Errorf }`, so the
  `tsk test` subcommand drives it directly.
- **`pass.ReadFile` is restricted** to the package's own files. The
  encapsulation linter walks parent directories for `go.mod`, so scripts need
  read access to the file system.

### Boundary cost

Microbenchmark of sobek with 100k identifiers on Apple Silicon:

| Pattern | ns/node |
|---|---|
| Pure JS loop | 64 |
| JS to Go call returning a bool | 571 |
| JS to Go call returning a wrapped `*ast.Ident` | 768 |
| Wrapped node plus one method call | 1331 |
| One Go call building 100k cursor wrappers, then iterating | 869 |
| Chunked ints, 256 per crossing, through a wrapped Go slice | 297 |
| Filter evaluated in Go, one crossing, results only | 42 |

Batching iteration alone buys about 2x, because every property or method
access on a wrapped value is another crossing. Moving the filter into Go buys
15 to 30x, because for a linter like `optionalnil` only about one identifier
in a hundred matches.

### Measured results

Each port was compared with its Go original on participle, kong, and hermit.

| Linter | Findings, Go and script | Time, Go to script |
|---|---|---|
| encapsulation | 229, identical | 0.55s to 0.60s; 0.53s to 0.70s; 11.1s to 11.0s |
| optionalnil | 227, identical | 0.37s to 0.42s; 0.39s to 0.46s; 0.87s to 1.67s |

Loading and type-checking the scripts takes about 40ms.

## Components

### Script compiler (`internal/typescript`, `internal/compile`)

`internal/typescript` is a nested module re-exporting what tsk needs
from the compiler:

- `NewProgram` type-checks a virtual file set as one strict ES2020 project.
- `Transpile` emits an ES2020 module with an inline source map.
- `Calls` finds every call the checker resolves to a declared function,
  including calls through aliases.
- `Describe` converts a type to a JSON-like `Shape` for config decoding.

Loading sources:

1. Collect `**/*.ts` from each source, skipping `testdata` and `types`
   directories and rejecting symlinks. Each source's files live under
   `/<source>/` in the virtual program.
2. Type-check the scripts together with the host declarations. Any diagnostic
   is a load error reported as `file:line:col`.
3. Insert each `defineAnalyzer` call's config schema index as a hidden first
   argument, because transpilation erases the type argument.
4. Transpile each script.
5. Parse every module once into records shared by all runtimes. The resolver
   confines relative imports to the importing script's source.
6. Evaluate in a bootstrap runtime to collect analyzer definitions.

Compiled-in sources come first and the `.tsk` directory last. A later
definition with the same name replaces an earlier one and is logged.

### Analyzer definition surface

Calling `defineAnalyzer` registers an analyzer; no particular export is
needed. The definition mirrors `analysis.Analyzer`:

- `name`, `doc`, `url`
- `config`: default values; see [Config](#config).
- `requires`: script analyzer handles, or host analyzers exported by
  `tsk/passes`, currently `inspect`.
- `facts`: fact handles created with `defineFact<T>(name)`. Handles carry the
  value type, so fact functions are typed without a second type parameter on
  `defineAnalyzer`, which TypeScript could not infer alongside an explicit
  config type.
- `runDespiteErrors`
- `scope`: `"module"`, the default, or `"all"`; see
  [Pass binding and runtime pool](#pass-binding-and-runtime-pool).
- `run(pass)`, whose return value is the analyzer's JSON result.

`resultOf` is typed for host analyzers. Script analyzer results are `unknown`,
for the same inference reason.

```ts
import { defineAnalyzer, defineFact } from "tsk";
import { inspect } from "tsk/passes";
import * as ast from "go/ast";

const generatedPackage = defineFact<Record<string, never>>("generatedPackage");

export default defineAnalyzer({
  name: "optionalnil",
  doc: "report nil used as an absent value instead of Option",
  requires: [inspect],
  facts: [generatedPackage],
  run(pass) {
    const root = pass.resultOf(inspect).root();
    for (const cursor of root.preorder(ast.Ident).filter(pass.typesInfo.isNil)) {
      // ...
    }
  },
});
```

### Config

Config replaces per-analyzer flags. Each analyzer declares a TypeScript config
type, and the host populates it from `.tsk.toml`.

**File.** `.tsk.toml` sits next to `.tsk/`. The global
`-config <path>` flag overrides discovery. The file holds one table per
analyzer, named after it, plus top-level settings choosing which analyzers
run: `disable` lists analyzers not to run, or `disable-all = true` with
`enable` lists the only ones that do. Combinations that would ignore a setting
are errors. Disabled analyzers still run when another requires them. The file
is parsed with go-toml, so decoding errors give a line and column.

**Declaring a config.** The script passes the type explicitly, as in
`defineAnalyzer<Config>({ config: defaults, run(pass) { ... } })`.

- The type parameter defaults to a type whose every key is `never`, so an
  analyzer without config omits both the type argument and `config`.
- `config` is required only when the config type has a required property.
- `config` is typed `NoInfer<Config>`, so TypeScript cannot infer the config
  type from the defaults. Without a type argument, any default fails the type
  check.

At load time the checker resolves the type argument and `Describe` converts it
to a shape. Allowed types are string, number, boolean, unions of string
literals, arrays, objects with known properties, and `Record<string, T>`.
Anything else is a load error at the call. Each property's JSDoc comment, read
with the compiler's own documentation lookup, documents the option; plain `//`
comments do not.

**Key mapping.** TOML keys are kebab-case: a hyphen goes before each uppercase
letter, then everything is lowercased. Property names containing `-` or `_`,
and properties mapping to the same key, are load errors. `Record` keys pass
through unchanged.

**Decoding.** The analyzer's table is decoded against the shape and merged over
the defaults. Objects merge key by key; arrays replace. Unknown keys, tables
naming unknown analyzers, and type mismatches are errors that name the file
and the key path, such as `encapsulation.allow-reads[0].writer`. The result is
a deep-frozen `pass.config`.

### Binding generator (`cmd/tsk-gen`, `internal/bindgen`)

The generator exposes Go packages by mirroring their APIs, so ports read like
their Go originals:

- the analysis framework: `go/token`, `go/constant`, `go/ast`, `go/types`, and
  the x/tools `edge`, `inspector`, and `typeutil` packages
- the system: `io/fs`, `path/filepath`, and `os` limited to reads: `Getwd`,
  `ReadFile`, `ReadDir`, `Readlink`, `Stat`, `Lstat`, their result types, and
  its error variables. Scripts may read the system but not change it.
- Go tooling: `go/build` and `golang.org/x/mod/modfile`

A package can be limited to an allowlist of members. A type that exists but is
not declared, such as `os.File`, is treated as unexposed everywhere, so no
declaration can name it.

For every declared member the generator emits:

- `internal/bindings/registry_gen.go`: functions, variables, constants, and
  types by Go name, the `(T, bool)` signatures whose bool is not an ok flag,
  such as `types.MissingMethod`, and which variables and types are error
  classes. The runtime reads every classification from the registry rather
  than deciding again, so declarations and runtime values agree.
- `internal/bindings/dts/*.d.ts`: one ambient module per package, importable
  by its Go import path.

Declarations follow these rules:

- Structs become interfaces with `$type` set to their Go type name, such as
  `"Ident"`, readonly fields, and methods. A value of the same name is a
  type token standing for a typed nil, as in `cursor.preorder(ast.Ident)`.
- Interfaces become unions of their package's implementations when every
  implementation in the package is exposed, so `if (t.$type === "Pointer")`
  narrows. Types in other packages are left out even when they match
  structurally, as `types.Scope` matches `ast.Node`; names within a package are
  unique, so tags cannot collide within a union.
  Unexported types that only serve as embedded bases, such as `types.object`,
  are ignored, as is a short reviewed list of types that never reach callers,
  currently `types.lazyObject`. Other interfaces, such as `constant.Value`,
  declare their methods.
- Error variables and error types become subclasses of `GoError`. An error
  variable is one whose type, `error` or concrete, implements `error`, such as
  `os.ErrNotExist`. An error type is any named, non-interface type where `T`
  or `*T` implements `error`, such as `fs.PathError` or `modfile.ErrorList`.
  Go's `error` type is `GoError | null`. See [Errors](#errors).
- Basic named types become `number` or `string`. Their methods become
  functions taking the receiver first, such as `edge.Kind.string(k)`.
- Functions and methods are lowerCamelCase. JavaScript reserved words get a
  trailing `_`, as in `types.implements_` and `inspector.new_`.

`bit gen` regenerates both outputs. The generator is a repository tool, not a
user-facing one.

### Runtime bridge (`internal/vm`)

Conversion rules:

| Go | JavaScript |
|---|---|
| nil pointer, interface, or function | `null`, declared as `T \| null` |
| nil slice | empty array |
| `(T, bool)` | `T \| undefined` |
| trailing `error` | thrown as a `GoError` subclass when non-nil; see [Errors](#errors) |
| other multiple results | tuple array |
| bool, string, numbers, named basic types | primitives |
| basic-kind value behind a non-empty interface, such as `constant.Value` | wrapped object, keeping its methods |
| slices and arrays | native arrays; `[]byte` is a string |
| maps | `MapView` with `get`, `has`, `keys`, `values`, `entries`, `size` |
| `iter.Seq` and `iter.Seq2` | `GoIterable`, pulled in batches |
| function parameters | JavaScript callbacks |
| structs and pointers | objects with their type's prototype |

Nil-safe Go methods do not survive the trip: a nil `*types.Tuple` is `null`,
not an empty tuple. The declarations type it as nullable, so the compiler makes
scripts handle it.

Wrappers of pointers, maps, channels, and basic values are cached by Go
identity in a scope, so the same Go value is the same object and works as a
`Map` key. Struct values, such as cursors and positions, are wrapped afresh
each time: Go compares them field by field, and caching them cost a
comparability walk and an allocation per wrap. Module evaluation uses a scope that lives as
long as the runtime. Each pass gets a scope that is dropped when `run`
returns, which also stops any sequence the script left unfinished.

### Traversal performance

**Native predicates.** Wrapped Go functions taking one argument and returning
`bool` are native predicates. `GoIterable.filter` given one runs the test in
Go and only wraps matches. A cursor stands for its node when a predicate takes
a node. `and`, `or`, and `not` stay native when all their operands are.
`types.Info` gains bound predicate properties `isNil` and `isType`.

**Batches.** `GoIterable` pulls up to 256 matching elements per crossing as
native arrays.

**Projections, deferred.** Returning plain records for many cursors in one call
would cut per-match cost further. The ports do not need it yet.

### Pass binding and runtime pool

go/analysis runs an analyzer that declares facts on every dependency, and
dependencies vastly outnumber the packages being linted. So by default an
analyzer runs only on packages of the main modules, which `go list -m` reports
once per run, including every module of a workspace. Other packages return an
empty result before any script work. An analyzer that needs facts about
dependencies declares `scope: "all"`. Without main modules, as for GOPATH-style
test data, no package is skipped. Dependencies are still loaded from source,
because multichecker decides how packages load.

`Analyzer.Run` borrows a runtime from a pool that grows lazily to
`GOMAXPROCS`. It builds the script's `Pass`, calls `run`, and returns the
result as `json.RawMessage`. A thrown exception becomes the analyzer error,
with a source-mapped stack.

The `Pass` mirrors `analysis.Pass`: `fset`, `files`, `otherFiles`,
`ignoredFiles`, `pkg`, `typesInfo`, `typesSizes`, `typeErrors`, `module`,
`config`, `report`, `resultOf`, `readFile`, and the six fact functions.
`report` takes a plain diagnostic object, including suggested fixes and related
information.

Runs cannot be interrupted, because `analysis.Pass` carries no context.

### Errors

Go functions report errors by throwing, and scripts catch them with ordinary
`instanceof` checks:

- `GoError`, from the `tsk` module, extends `Error` and is the base of
  every Go error. Any Go value implementing `error` is a `GoError`, and its
  `message` is `Error()`.
- An error type, such as `fs.PathError`, is a class, and every value of it is
  an instance, whatever its kind. A thrown error takes the class of the first
  exposed error type in its wrap chain, with that error's fields readable, as
  `errors.As` would find it. Otherwise it is a plain `GoError`. Error types
  that are slices, such as `modfile.ErrorList`, also have `length`, `at`, and
  iteration, as Go code ranges over them.
- An error variable, such as `os.ErrNotExist`, is a class whose `instanceof`
  asks Go's `errors.Is`. A thrown `*fs.PathError` is therefore both an
  `fs.PathError` and an `os.ErrNotExist`. Variables shared between packages,
  such as `os.ErrNotExist` and `fs.ErrNotExist`, are one class.
- The exception's message is the full `Error()` text, and passing a caught
  exception back to Go passes the original error.

Callbacks cannot yet return error variables to Go, as `filepath.WalkDir`
callbacks return `fs.SkipDir`, because a class is not an error value.

### Facts

`internal/facts` declares 256 named types, each embedding a `Payload` that
holds the fact's name and JSON value. Each analyzer's facts are assigned
distinct types. `String()` renders `name JSON`, which `analysistest` fact
expectations match.

### Suppression

The engine drops a script analyzer's findings that a `//nolint` comment
covers, following golangci-lint, so no script implements its own directive.
`//nolint:a,b` names analyzers, and a bare `//nolint` covers all of them; a
reason may follow after a space. The comment covers its own line, and on the
line above a node in the same column it covers the whole node. `internal/nolint`
scans a package's comments only once it reports a finding.

### Script helpers (`tsk` module)

- `console.debug`, `log`, `info`, `warn`, and `error`, written to tsk's
  log at the matching level and tagged with the analyzer and package during a
  run. The log level defaults to `error`; `--log-level` changes it.

### Drivers and distribution

**`tsk` CLI.** Kong parses every command line, so all help comes from
Kong:

- `lint` (the default): lints package patterns, `./...` by default, with
  `--fix`, `--diff`, `--json`, `--context`, and `--[no-]test`. Kong's parsed
  options are passed to `multichecker` as `flag` arguments, because it parses
  its own options and exits.
- `test`: runs `analysistest` for each analyzer with
  `<scripts>/testdata/<analyzer>/`. An optional `tsk.test.toml` there
  lists `[[case]]` entries with a name, optional `dir`, package patterns, and
  an inline config table.
- `check`: type-checks scripts and validates the config.
- `init`: writes the declarations to `<scripts>/types/` and a matching
  `tsconfig.json`.
- `config`: prints a `.tsk.toml` documenting analyzers: where each is
  defined, whether the config enables it, and each option at its default with
  its JSDoc comment. Arrays of tables are multi-line inline tables, a TOML 1.1
  form, so each field carries its comment; an empty one shows a placeholder
  entry of zero values to fill in or delete. So the output is a reference to
  edit, not a config that loads unchanged. The defining script comes from the
  JavaScript call stack when `defineAnalyzer` runs.

**Discovery.** `.tsk/` and `.tsk.toml` are found beside the
nearest `go.mod` above the working directory. `--dir` and `--config` override
them.

golangci-lint and `go vet -vettool` integration are out of scope.

## Repository layout

- `cmd/tsk/`, `cmd/tsk-gen/`: entry points, holding all flag
  parsing and bootstrap.
- `internal/typescript/`: the shim module.
- `internal/compile/`, `internal/config/`, `internal/naming/`: loading,
  config, and the naming rules the generator and runtime share.
- `internal/bindgen/`, `internal/bindings/`: the generator and its output.
- `internal/hostapi/`: the hand-written `tsk` module and declarations.
- `internal/vm/`, `internal/facts/`, `internal/engine/`: the runtime, fact pool,
  and analyzer construction.
- `internal/project/`: discovery, loading, and editor files.
- `internal/scripttest/`: test cases and the test runner.
- `linters/`: the compiled-in ports and their test data. `bit lint` runs them
  on this repository.

## Risks

- **Toolchain coupling.** The `tsc` pseudo-version and the shim break if the
  TypeScript team restructures `internal/`. Spectre carries the same risk.
- **Hidden implementers.** A new unexported implementation of an exposed
  interface makes the generator fall back to an open interface, breaking
  narrowing in scripts until it is reviewed.
- **Per-node callbacks.** `ast.Inspect` with a JavaScript callback crosses
  the boundary per node. The encapsulation port stays close to Go speed
  because package loading dominates, but heavier callback use will not.
