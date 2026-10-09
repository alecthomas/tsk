# Tsk

Tsk (`tsk`) runs Go linters written in TypeScript. Each script is a real
[`go/analysis`](https://pkg.go.dev/golang.org/x/tools/go/analysis) analyzer,
with access to the Go AST, type information, and facts, through APIs that
mirror Go's own. Your project's linters live alongside its code in
`.tsk/`, so there is no driver, plugin, or build step to maintain. Linters
shared between projects come from git repositories as libraries.

## Install

Download a prebuilt binary for your platform from the
[releases page](https://github.com/alecthomas/tsk/releases) and put it
on your `PATH`.

To build from source instead:

```sh
git clone https://github.com/alecthomas/tsk
cd tsk
go build -o ~/go/bin/tsk ./cmd/tsk
```

Optionally Install linters from [libraries](#Libraries):

```sh
tsk add github.com/alecthomas/tsk//linters
```


## Quick start

Put this in `.tsk/nopanic.ts` at the root of your repository:

```ts
import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";
import * as ast from "go/ast";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";

interface Config {
  /** The message reported for each call to panic. */
  message: string;
}

export default defineAnalyzer<Config>({
  name: "nopanic",
  doc: "report calls to panic",
  requires: [inspect],
  config: { message: "panic is not allowed" },
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      const callee = typeutil.callee(pass.typesInfo, call);
      if (callee?.$type === "Builtin" && callee.name() === "panic") {
        pass.report({ pos: call.pos(), message: pass.config.message });
      }
    }
  },
});
```

Optionally, configure it in `.tsk/config.toml`:

```toml
[nopanic]
message = "return an error instead of panicking"
```

Then run it:

```sh
tsk
```

```text
package/path//demo.go:4:2: return an error instead of panicking
```

`tsk` lints `./...` by default; pass package patterns to narrow it. It exits
with status 3 when it reports findings. Alongside your scripts, it runs the
linters of any [libraries](#using-libraries) you import. `tsk list` lists
every linter, and `tsk config` documents their options.

## Libraries

These libraries are known to work with `tsk`. Add one with `tsk get
<library>`.

| Library | Linters |
|---|---|
| `github.com/alecthomas/tsk//linters` | `encapsulation` reports private-field access and construction outside a struct's API. `optionalnil` reports nil used to mean "no value" where an option type could be used. `sumtype` checks that type switches on sealed interfaces cover every variant. Ports of golangci-lint linters, with upstream's options and defaults: `asasalint`, `asciicheck`, `bidichk`, `bodyclose`, `canonicalheader`, `copyloopvar`, `cyclop`, `dupl`, `durationcheck`, `errcheck`, `errname`, `errorlint`, `exhaustive`, `exptostd`, `fatcontext`, `forbidigo`, `funcorder`, `funlen`, `gocheckcompilerdirectives`, `gochecknoglobals`, `goconst`, `godoclint`, `godot`, `gomoddirectives`, `goprintffuncname`, `iface`, `ineffassign`, `intrange`, `iotamixing`, `loggercheck`, `makezero`, `mirror`, `nakedret`, `nilerr`, `nilnesserr`, `nilnil`, `noctx`, `nosprintfhostport`, `perfsprint`, `predeclared`, `promlinter`, `protogetter`, `reassign`, `recvcheck`, `rowserrcheck`, `spancheck`, `sqlclosecheck`, `testableexamples`, `testifylint`, `testpackage`, `tparallel`, `unconvert`, `unparam`, `unused`, `usestdlibvars`, `usetesting`, `wastedassign`, `whitespace`, `wrapcheck`. |

## Reference

### Commands

| Command | Does |
|---|---|
| `tsk [lint] [packages...]` | Lints packages with every enabled linter. `--fix` applies suggested fixes, `--diff` prints them instead, `--json` emits JSON, `-c N` shows N lines of context, and `--no-test` skips test files. |
| `tsk test` | Runs each linter against its test data. See [Writing tests](#writing-tests). |
| `tsk check` | Type-checks scripts and validates `.tsk/config.toml`. |
| `tsk init` | Writes the script declarations to `.tsk/types/` and a `tsconfig.json` to `.tsk/`, for editor completion and type checking. |
| `tsk config [linters...]` | Prints a `.tsk/config.toml` documenting each linter and option, set to its default. |
| `tsk list` | Lists every linter, whether it is enabled, where it is defined, and its summary. `--json` prints a JSON array instead, with each linter's full documentation and URL. |
| `tsk get [libraries...]` | Adds or updates [libraries](#using-libraries) and pins them in `.tsk/lock.toml`. |
| `tsk sync` | Downloads every pinned library missing from the cache. |

`tsk` uses the nearest `.tsk/` at or above the working directory, searching up
to your home directory, so modules in one repository can share it. If there is
none, `tsk init` creates it beside the nearest `go.mod`. The config file is
`config.toml` inside it. `--dir` and `--config` override them. `--log-level`
sets the level of script and `tsk` logging, which defaults to `error`.
`--cache`, or `TSK_CACHE`, sets where libraries are cached.

### Configuration

`.tsk/config.toml` holds one table per linter, named after it, plus settings that
choose which linters run:

```toml
# Run every linter except these.
disable = ["nopanic"]

# Or run only these.
# disable-all = true
# enable = ["nopanic"]

[nopanic]
message = "return an error instead of panicking"
```

A disabled linter still runs when an enabled one requires it. Unknown linters,
unknown options, and values of the wrong type are errors.

Findings in generated files are dropped, as golangci-lint drops them: a file is
generated when, before its package clause, it has a line matching
`^// Code generated .* DO NOT EDIT\.$`. Findings in `_test.go` files can be
dropped too:

```toml
# Keep findings in generated files.
lint-generated = true

# Drop findings in test files for these linters.
skip-tests = ["dupl", "funlen"]

# Or for every linter, as --no-test does.
# no-tests = true
```

`tsk config` output is a starting point for this file. Empty lists show one
placeholder entry to fill in or delete.

### Using libraries

A library is a directory of linter scripts in a git repository, shared between
projects. Add one with `tsk get`:

```sh
tsk get github.com/acme/linters@v1.2.0
```

This adds it to the `imports` setting in `.tsk/config.toml`, and pins it to a
commit in `.tsk/lock.toml`:

```toml
imports = [
  "github.com/acme/linters@v1.2.0",
]
```

Every linter in a listed library runs, as if its scripts were in `.tsk/`. Turn
off the ones you do not want with `disable`. `tsk get` prints the linters each
change adds or removes, because an update can add new ones.

An import is `<repository>[@<version>][//<dir>]`:

- The repository is fetched from `https://<repository>`, with your git
  credentials, so private repositories work. To use SSH instead, rewrite the
  URL with git's `url.<base>.insteadOf` setting.
- The version is a tag, branch, or commit. Without one, `tsk get` picks the
  highest semver tag, or the default branch if there are none.
- `//<dir>` names a directory within the repository holding the scripts, as in
  `github.com/acme/linters@v1.2.0//strict`. Without it, the library is the
  whole repository. One import cannot lie within another.

Commit `lock.toml`, so everyone runs the same commit of each library. `tsk get`
without arguments updates the lock file after you edit `imports` by hand, and
naming an import without a version, as in `tsk get github.com/acme/linters`,
updates it to its latest version. Until the lock file matches `imports`, other
commands fail.

`tsk` needs `git` to download libraries. It keeps them in `tsk` in your user
cache directory, such as `~/Library/Caches/tsk` on macOS. Commands download a
pinned library the first time they need it, and otherwise work offline. `tsk
sync` downloads them all in advance, as for CI. Deleting the cache is always
safe.

Your scripts can import a library's scripts by its repository and directory
joined, as in `import { helper } from "github.com/acme/linters/strict/helper"`.
A library's scripts can import each other only by relative paths, not other
libraries. Rerun `tsk init` after `tsk get`, so your editor finds library
scripts.

To write a library, put scripts and their `testdata/` in a directory of a git
repository, and run `tsk test --dir <directory>` there to test them.

To try a library in a project while you develop it, or to use one that is not
published, replace its import with a local directory:

```toml
imports = [
  "github.com/acme/linters@v1.2.0//strict",
]

replace = { "github.com/acme/linters//strict" = "../linters/strict" }
```

The key is the import without its version, and the directory is relative to
`config.toml`. A replaced library loads from that directory on every run, and
is never fetched or locked. Its import still needs a version, which `tsk get`
pins once you remove the replacement. `replace` is committed with the rest of
the config, so remove one meant only for your machine before you commit.

### Suppressing findings

Suppress findings with a `//nolint:<linter>[,<linter>...] [<reason>]` comment,
as with golangci-lint. At the end of a line it covers that line. On its own
line it also covers the declaration or statement below it, when that starts in
the same column. A bare `//nolint` covers every linter.

### Writing linters

#### Scripts

`tsk` loads every `.ts` file under `.tsk/`, including subdirectories, except
those under `testdata/` and `types/`. Scripts can import each other with
relative paths, and [library](#using-libraries) scripts by path, but not packages
from npm. A script defining a linter with the same name as a library one
replaces it. Two libraries defining the same linter is an error.

Scripts are type-checked as one strict ES2020 project before they run.
Errors point at your `.ts` source, and so do the stack traces of exceptions
thrown during a run.

#### Defining a linter

Calling `defineAnalyzer` registers a linter. Its definition mirrors
[`analysis.Analyzer`](https://pkg.go.dev/golang.org/x/tools/go/analysis#Analyzer):

| Field | Purpose |
|---|---|
| `name` | A Go identifier. It names the linter in `.tsk/config.toml`, `//nolint` comments, and output. |
| `doc` | The documentation. The first line is a summary. |
| `url` | Optional link to more documentation. |
| `config` | Default option values. See [Options](#options). |
| `requires` | Linters whose results `run` reads, from other scripts or from `tsk/passes`. |
| `facts` | Every fact the linter imports or exports. See [Facts](#facts). |
| `scope` | `"module"`, the default, runs only on packages of the modules being linted. `"all"` also runs on every dependency. |
| `runDespiteErrors` | Run on packages that fail to type-check. |
| `tests` | `false` drops the linter's findings in `_test.go` files, for rules that do not suit tests. |
| `run(pass)` | Analyzes one package. Its return value, which must be JSON, is the result other linters read with `pass.resultOf`. |

`tsk/passes` exports `inspect`, whose result is an
[`inspector.Inspector`](https://pkg.go.dev/golang.org/x/tools/go/ast/inspector)
for the package; `buildssa`, whose result is the package in
[SSA form](https://pkg.go.dev/golang.org/x/tools/go/ssa) with its functions
declared in source, for linters that follow data flow; and `ctrlflow`, whose
result holds the [control-flow graph](https://pkg.go.dev/golang.org/x/tools/go/cfg)
of each function.

#### Options

Pass the options type to `defineAnalyzer`, as in `defineAnalyzer<Config>`, and
give every option a default in `config`. A linter without options omits both.

Options may be strings, numbers, booleans, unions of string literals, arrays,
objects with known properties, and `Record<string, T>`. A JSDoc comment on a
property documents it in `tsk config`; a plain `//` comment does not.

In `.tsk/config.toml`, property names become kebab-case, so `allowReads` is set as
`allow-reads`. Values from the file are merged over the defaults: objects key
by key, while arrays replace. `pass.config` holds the result and is read-only.

#### The pass

`run` receives a `Pass`, which mirrors
[`analysis.Pass`](https://pkg.go.dev/golang.org/x/tools/go/analysis#Pass):

- `fset`, `files`, `otherFiles`, `ignoredFiles`, `pkg`, `typesInfo`,
  `typesSizes`, and `typeErrors`, as in Go.
- `module`: the package's module path, version, and Go version, if it has a
  module.
- `config`: the linter's options.
- `report(diagnostic)`: reports a finding. A diagnostic is a plain object with
  `pos` and `message`, and optionally `end`, `category`, `url`,
  `suggestedFixes`, and `related`.
- `resultOf(linter)`: the result of a required linter.
- `readFile(filename)`: reads one of the package's files.
- `importObjectFact`, `exportObjectFact`, `importPackageFact`,
  `exportPackageFact`, `allObjectFacts`, and `allPackageFacts`.

#### Go APIs

Scripts import Go packages by their import paths:

- `go/ast`, `go/constant`, `go/token`, and `go/types`
- `golang.org/x/tools/go/ast/edge`, `golang.org/x/tools/go/ast/inspector`,
  `golang.org/x/tools/go/ssa`, and `golang.org/x/tools/go/types/typeutil`
- `go/build` and `golang.org/x/mod/modfile`
- `io/fs`, `path/filepath`, and a read-only subset of `os`

Their APIs follow Go's, with these conversions:

- **Names.** Functions, methods, and fields are lowerCamelCase. Names that are
  JavaScript reserved words end in `_`, as in `types.implements_`.
- **Narrowing.** Each struct value has a `$type` tag holding its Go type name,
  without the package, so `if (t.$type === "Pointer")` narrows a `types.Type`.
- **Type tokens.** A struct type's name is also a value standing for it, as in
  `cursor.preorder(ast.CallExpr)`.
- **Nil.** A nil pointer, interface, or function is `null`. A nil slice is an
  empty array.
- **Pointers to slices and interfaces** read as their target, so
  `value.referrers()` is an array.

`go/format` takes an `io.Writer`, so `tsk` exports `formatNode(node, fset?)`
instead. It returns the node as `go/format` prints it: on one line without a
file set, or in its source layout with `pass.fset`. Use it for messages and
suggested fixes; `types.exprString` abbreviates function and composite
literals.
- **Results.** A `(value, ok)` result is the value or `undefined`. Other
  multiple results are arrays.
- **Errors.** A non-nil trailing `error` result is thrown. Go errors extend
  `GoError` from `tsk`. Error types such as `fs.PathError` and error variables
  such as `os.ErrNotExist` are classes, so `err instanceof os.ErrNotExist` works
  as `errors.Is` does.
- **Collections.** Slices are arrays. Maps are read-only `MapView`s, with Go
  keys, so `pass.typesInfo.defs.get(ident)` works. Go iterators are
  `GoIterable`s.
- **Identity.** The same Go pointer is always the same JavaScript object, so
  objects and nodes work as `Map` and `Set` keys.
- **Named basic types.** Types such as `token.Pos` are numbers or strings.
  Their methods are functions taking the value first, as in
  `edge.Kind.string(kind)`.

#### Traversing syntax

Each JavaScript call into Go has a cost, so let Go do the filtering where it
can. `cursor.preorder(...types)` visits only nodes of the given types. A
`GoIterable`'s `filter` runs in Go when given a native predicate, such as
`pass.typesInfo.isNil` or `pass.typesInfo.isType`. `and`, `or`, and `not` from
`tsk` combine predicates and stay native when every operand is:

```ts
for (const cursor of root.preorder(ast.Ident).filter(pass.typesInfo.isNil)) {
  // Only nil identifiers reach JavaScript.
}
```

A JavaScript callback, as `ast.inspect` takes, runs once per node, so prefer
the inspector for large traversals.

#### Facts

Facts carry what a linter learns about a package to the packages that import
it. Create a handle with `defineFact<T>(name)`, list it in `facts`, and export
and import values with the pass. Values must be JSON and must not depend on
options.

By default, a linter runs only on the modules being linted, so it never sees
facts about dependencies in other modules. Set `scope: "all"` when it needs
them:

```ts
import { defineAnalyzer, defineFact } from "tsk";
import { inspect } from "tsk/passes";
import * as ast from "go/ast";
import * as typeutil from "golang.org/x/tools/go/types/typeutil";

const panics = defineFact<{ direct: boolean }>("panics");

export default defineAnalyzer({
  name: "panics",
  doc: "report calls to functions that panic",
  requires: [inspect],
  facts: [panics],
  scope: "all",
  run(pass) {
    const root = pass.resultOf(inspect).root();
    for (const cursor of root.preorder(ast.FuncDecl)) {
      const fn = pass.typesInfo.defs.get((cursor.node() as ast.FuncDecl).name!);
      const callsPanic = cursor
        .preorder(ast.CallExpr)
        .toArray()
        .some((c) => typeutil.callee(pass.typesInfo, c.node() as ast.CallExpr)?.name() === "panic");
      if (fn != null && callsPanic) {
        pass.exportObjectFact(fn, panics, { direct: true });
      }
    }
    for (const cursor of root.preorder(ast.CallExpr)) {
      const call = cursor.node() as ast.CallExpr;
      const callee = typeutil.callee(pass.typesInfo, call);
      if (callee !== null && pass.importObjectFact(callee, panics) !== undefined) {
        pass.report({ pos: call.pos(), message: `${callee.name()} may panic` });
      }
    }
  },
});
```

#### Logging

`console.debug`, `log`, `info`, `warn`, and `error` write to `tsk`'s log at the
matching level, tagged with the linter and package. `console.log` is info.
Pass `--log-level debug` to see everything.

### Writing tests

`tsk test` runs each linter in `.tsk/` with
[`analysistest`](https://pkg.go.dev/golang.org/x/tools/go/analysis/analysistest)
against the Go packages in `.tsk/testdata/<linter>/`. It prints `ok` or `FAIL`
for each case, and fails when any case fails. Linters without test data are
skipped.

#### Test data

The test data directory is either a module or a GOPATH tree:

```text
.tsk/testdata/
├── nopanic/              # GOPATH tree: packages under src/
│   ├── tsk.test.toml
│   └── src/
│       ├── demo/demo.go
│       └── custom/custom.go
└── panics/               # Module: go.mod at the top
    ├── go.mod
    ├── lib/lib.go
    └── app/app.go
```

Use a module when the code under test imports packages by module path. The Go
toolchain ignores `testdata` directories, so test data does not affect your
build. Every test package counts as part of the modules being linted, whatever
the linter's scope.

#### Expectations

A `// want` comment lists what the linter must report on its line, and every
finding must be expected. Each expectation is a regular expression in double
quotes or backquotes that must match a finding's message:

```go
func explode() {
	panic("boom") // want `panic is not allowed`
}
```

`name:"pattern"` expects a fact on the object `name` declared on that line. A
fact's text is its name followed by its JSON value:

```go
func Must(err error) { // want Must:`panics \{"direct":true\}`
```

Package facts use the name `package`, on line 1 of the package's first file.
One comment may hold several expectations, as in
``// want `first` `second` Must:`panics` ``.

`//nolint` comments apply in tests, so test data can check suppression too.

#### Cases

Without a `tsk.test.toml`, a linter has one case that checks `./...` with
default options. To test other packages or options, list cases in
`tsk.test.toml` beside the test data:

```toml
[[case]]
name = "default"
packages = ["demo"]

[[case]]
name = "custom-message"
packages = ["custom"]
[case.config]
message = "return an error instead"
```

Each case needs a `name` and package patterns. `config` sets options as in
`.tsk/config.toml`, and `dir` points the case at a subdirectory of the test data,
such as a separate module.
