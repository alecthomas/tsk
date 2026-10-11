# Linters

This library holds linters written for `tsk` and ports of golangci-lint's
linters. Add it to a project with `tsk get github.com/alecthomas/tsk//linters`.
Every linter runs once the library is imported; turn off the ones you do not
want with `disable` in `.tsk/config.toml`. `tsk config` documents each
linter's options.

## Original linters

| Linter | Reports |
|---|---|
| `encapsulation` | Private-field access and construction outside a struct's API. |
| `nolintlint` | Ill-formed or insufficient `//nolint` directives. An original implementation of golangci-lint's nolintlint, which is GPL-3.0, with its options and messages, except that unused directives are not reported. |
| `optionalnil` | `nil` used to mean "no value" where an option type could be used. |
| `sumtype` | Type switches on sealed interfaces that miss a variant. |

## Ports

Each port reproduces its upstream linter as golangci-lint v2.14.0 runs it, with
the same options and defaults. The license is upstream's; each port is a
translation of that code.

| Linter | License | Description |
|---|---|---|
| [`asasalint`](https://github.com/alingse/asasalint) | MIT | Check for passing []any as any in variadic func(...any). |
| [`asciicheck`](https://github.com/golangci/asciicheck) | MIT | Check that declared identifiers contain only ASCII characters. |
| [`bidichk`](https://github.com/breml/bidichk) | MIT | Check for dangerous unicode character sequences. |
| [`bodyclose`](https://github.com/timakin/bodyclose) | MIT | Check whether HTTP response bodies are closed. |
| [`canonicalheader`](https://github.com/golangci/canonicalheader) | MIT | Check that net/http.Header keys are canonical. |
| [`contextcheck`](https://github.com/kkHAIKE/contextcheck) | Apache-2.0 | Check whether the function uses a non-inherited context. |
| [`copyloopvar`](https://github.com/karamaru-alpha/copyloopvar) | MIT | Detect places where loop variables are copied. |
| [`cyclop`](https://github.com/bkielbasa/cyclop) | MIT | Checks function and package cyclomatic complexity. |
| [`decorder`](https://gitlab.com/bosi/decorder) | MIT | Check declaration order and count of types, constants, variables and functions. |
| [`dogsled`](https://github.com/alexkohler/dogsled) | MIT | Checks assignments with too many blank identifiers. |
| [`dupl`](https://github.com/golangci/dupl) | MIT | Detect duplicate fragments of code. |
| [`dupword`](https://github.com/Abirdcfly/dupword) | MIT | Checks for duplicate words in the source code. |
| [`durationcheck`](https://github.com/charithe/durationcheck) | Apache-2.0 | Check for two durations multiplied together. |
| [`embeddedstructfieldcheck`](https://github.com/manuelarte/embeddedstructfieldcheck) | Apache-2.0 | Embedded types should be at the top of the field list of a struct, and there must be an empty line separating embedded fields from regular fields. |
| [`errcheck`](https://github.com/kisielk/errcheck) | MIT | Check for unchecked errors. |
| [`errchkjson`](https://github.com/breml/errchkjson) | MIT | Checks types passed to the json encoding functions. |
| [`errname`](https://github.com/Antonboom/errname) | MIT | Check that sentinel errors are prefixed with Err and error types are suffixed with Error. |
| [`errorlint`](https://codeberg.org/polyfloyd/go-errorlint) | MIT | Find code that will fail on errors wrapped as Go 1.13 introduced. |
| [`exhaustive`](https://github.com/nishanths/exhaustive) | BSD-2-Clause | Check exhaustiveness of enum switch statements and map literals. |
| [`exhaustruct`](https://github.com/GaijinEntertainment/go-exhaustruct) | MIT | Checks if all structure fields are initialized. Ports version 5, which golangci-lint calls `exhaustruct_v5`. |
| [`exptostd`](https://github.com/ldez/exptostd) | Apache-2.0 | Detect functions from golang.org/x/exp/ that can be replaced by std functions. |
| [`fatcontext`](https://github.com/Crocmagnon/fatcontext) | MIT | Detect nested contexts in loops and function literals. |
| [`forbidigo`](https://github.com/ashanbrown/forbidigo) | Apache-2.0 | Forbid identifiers. |
| [`forcetypeassert`](https://github.com/gostaticanalysis/forcetypeassert) | MIT | Finds forced type assertions. |
| [`funcorder`](https://github.com/manuelarte/funcorder) | Apache-2.0 | Check the order of functions, methods, and constructors. |
| [`funlen`](https://github.com/ultraware/funlen) | MIT | Check for long functions. |
| [`gocheckcompilerdirectives`](https://github.com/leighmcculloch/gocheckcompilerdirectives) | MIT | Check that go compiler directive comments (//go:) are valid. |
| [`gochecknoglobals`](https://github.com/leighmcculloch/gochecknoglobals) | MIT | Check that no global variables exist. |
| [`gochecknoinits`](https://github.com/leighmcculloch/gochecknoinits) | MIT | Checks that no init functions are present in Go code. |
| [`gocognit`](https://github.com/uudashr/gocognit) | MIT | Computes and checks the cognitive complexity of functions. |
| [`goconst`](https://github.com/jgautheron/goconst) | MIT | Find repeated strings that could be replaced by a constant. |
| [`gocyclo`](https://github.com/fzipp/gocyclo) | BSD-3-Clause | Computes and checks the cyclomatic complexity of functions. |
| [`godoclint`](https://github.com/godoc-lint/godoc-lint) | MIT | Check Go documentation practice. |
| [`godot`](https://github.com/tetafro/godot) | MIT | Check if comments end in a period. |
| [`godox`](https://github.com/matoous/godox) | MIT | Detects usage of FIXME, TODO and other keywords inside comments. |
| [`gomoddirectives`](https://github.com/ldez/gomoddirectives) | Apache-2.0 | Manage the use of replace, retract, exclude, and other directives in go.mod. |
| [`gomodguard`](https://github.com/ryancurrah/gomodguard) | MIT | Allow and block lists for direct module dependencies. |
| [`gomodguard_v2`](https://github.com/ryancurrah/gomodguard) | MIT | Allow and block lists for direct module dependencies, matched exactly, by prefix, or by regular expression. |
| [`goprintffuncname`](https://github.com/golangci/go-printf-func-name) | MIT | Check that printf-like functions are named with f at the end. |
| [`iface`](https://github.com/uudashr/iface) | Apache-2.0 | Detect the incorrect use of interfaces, helping avoid interface pollution. |
| [`importas`](https://github.com/julz/importas) | Apache-2.0 | Enforces consistent import aliases. |
| [`inamedparam`](https://github.com/macabu/inamedparam) | MIT | Reports interfaces with unnamed method parameters. |
| [`ineffassign`](https://github.com/gordonklaus/ineffassign) | MIT | Detect assignments to existing variables that are never used. |
| [`interfacebloat`](https://github.com/sashamelentyev/interfacebloat) | MIT | A linter that checks the number of methods inside an interface. |
| [`intrange`](https://github.com/ckaznocha/intrange) | MIT | Intrange is a linter to find places where for loops could make use of an integer range. |
| [`iotamixing`](https://github.com/AdminBenni/iota-mixing) | MIT | Checks if iotas are being used in const blocks with other non-iota declarations. |
| [`ireturn`](https://github.com/butuzov/ireturn) | MIT | Accept Interfaces, Return Concrete Types. |
| [`lll`](https://github.com/walle/lll) | MIT | Reports long lines. |
| [`loggercheck`](https://github.com/timonwong/loggercheck) | MIT | Checks key value pairs for common logger libraries (kitlog,klog,logr,slog,zap). |
| [`makezero`](https://github.com/ashanbrown/makezero) | Apache-2.0 | Find slice declarations with non-zero initial length. |
| [`mirror`](https://github.com/butuzov/mirror) | MIT | Reports wrong mirror patterns of bytes/strings usage. |
| [`misspell`](https://github.com/golangci/misspell) | MIT | Finds commonly misspelled English words. |
| [`nakedret`](https://github.com/alexkohler/nakedret) | MIT | Checks that functions with naked returns are not longer than a maximum size (can be zero). |
| [`nestif`](https://github.com/nakabonne/nestif) | BSD-2-Clause | Reports deeply nested if statements. |
| [`nilerr`](https://github.com/gostaticanalysis/nilerr) | MIT | Find the code that returns nil even if it checks that the error is not nil. |
| [`nilnesserr`](https://github.com/alingse/nilnesserr) | MIT | Reports constructs that checks for err != nil, but returns a different nil value error. |
| [`nilnil`](https://github.com/Antonboom/nilnil) | MIT | Checks that there is no simultaneous return of `nil` error and an invalid value. |
| [`noctx`](https://github.com/sonatard/noctx) | MIT | Detects function and method with missing usage of context.Context. |
| [`noinlineerr`](https://github.com/AlwxSin/noinlineerr) | MIT | Disallows inline error handling (`if err := ...; err != nil {`). |
| [`nosprintfhostport`](https://github.com/stbenjam/no-sprintf-host-port) | MIT | Checks for misuse of Sprintf to construct a host with port in a URL. |
| [`paralleltest`](https://github.com/kunwardeep/paralleltest) | MIT | Checks that tests use t.Parallel. |
| [`perfsprint`](https://github.com/catenacyber/perfsprint) | MIT | Checks that fmt.Sprintf can be replaced with a faster alternative. |
| [`prealloc`](https://github.com/alexkohler/prealloc) | MIT | Find slice declarations that could potentially be pre-allocated. |
| [`predeclared`](https://github.com/nishanths/predeclared) | BSD-3-Clause | Find code that shadows one of Go's predeclared identifiers. |
| [`promlinter`](https://github.com/yeya24/promlinter) | Apache-2.0 | Check Prometheus metrics naming via promlint. |
| [`protogetter`](https://github.com/ghostiam/protogetter) | MIT | Reports direct reads from proto message fields when getters should be used. |
| [`reassign`](https://github.com/curioswitch/go-reassign) | MIT | Checks that package variables are not reassigned. |
| [`recvcheck`](https://github.com/raeperd/recvcheck) | MIT | Checks for receiver type consistency. |
| [`revive`](https://github.com/mgechev/revive) | MIT | Fast, configurable, extensible, flexible, and beautiful linter for Go. Drop-in replacement of golint. Rule arguments are typed tables named after their rule, such as `[revive.line-length-limit]`. `struct-tag` includes a port of [`fatih/structtag`](https://github.com/fatih/structtag) v1.2.0, BSD-3-Clause. |
| [`rowserrcheck`](https://github.com/golangci/rowserrcheck) | MIT | Checks whether Rows.Err of rows is checked successfully. |
| [`spancheck`](https://github.com/jjti/go-spancheck) | MIT | Checks for mistakes with OpenTelemetry/Census spans. |
| [`sqlclosecheck`](https://github.com/ryanrolds/sqlclosecheck) | MIT | Checks that sql.Rows, sql.Stmt, sqlx.NamedStmt, pgx.Query are closed. |
| [`tagalign`](https://github.com/4meepo/tagalign) | MIT | Check that struct tags are well aligned. |
| [`testableexamples`](https://github.com/maratori/testableexamples) | MIT | Linter checks if examples are testable (have an expected output). |
| [`testifylint`](https://github.com/Antonboom/testifylint) | MIT | Checks usage of github.com/stretchr/testify. |
| [`testpackage`](https://github.com/maratori/testpackage) | MIT | Linter that makes you use a separate _test package. |
| [`thelper`](https://github.com/kulti/thelper) | MIT | Detects test helpers which do not start with the t.Helper() method. |
| [`tparallel`](https://github.com/moricho/tparallel) | MIT | Tparallel detects inappropriate usage of t.Parallel() method in your Go test codes. |
| [`unconvert`](https://github.com/golangci/unconvert) | BSD-3-Clause | Remove unnecessary type conversions. |
| [`unparam`](https://github.com/mvdan/unparam) | BSD-3-Clause | Reports unused function parameters. |
| [`unused`](https://github.com/dominikh/go-tools) | MIT | Checks Go code for unused constants, variables, functions and types. |
| [`usestdlibvars`](https://github.com/sashamelentyev/usestdlibvars) | MIT | A linter that detect the possibility to use variables/constants from the Go standard library. |
| [`usetesting`](https://github.com/ldez/usetesting) | Apache-2.0 | Reports uses of functions with replacement inside the testing package. |
| [`varnamelen`](https://github.com/blizzy78/varnamelen) | MIT | Checks that the length of a variable's name matches its scope. |
| [`wastedassign`](https://github.com/sanposhiho/wastedassign) | MIT | Finds wasted assignment statements. |
| [`whitespace`](https://github.com/ultraware/whitespace) | MIT | Whitespace is a linter that checks for unnecessary newlines at the start and end of functions, if, for, etc. |
| [`wrapcheck`](https://github.com/tomarrell/wrapcheck) | MIT | Checks that errors returned from external packages are wrapped. |

## Vet analyzers

golangci-lint runs these through its `govet` linter. Here each is a linter of
its own, so `disable`, `//nolint`, and options name the analyzer, as in
`[printf]`. They port the analyzers of
[`golang.org/x/tools/go/analysis/passes`](https://pkg.go.dev/golang.org/x/tools/go/analysis/passes)
v0.50.0, BSD-3-Clause, including those `go vet` does not run, so `go vet` is
not needed alongside them. All of them run, unlike golangci-lint's `govet`,
which leaves `atomicalign`, `deepequalerrors`, `fieldalignment`, `httpmux`,
`nilness`, `reflectvaluecompare`, `shadow`, `sortslice`, and `unusedwrite` off
by default.

| Linter | Description |
|---|---|
| `appends` | Check for missing values after append. |
| `asmdecl` | Report mismatches between assembly files and Go declarations. |
| `assign` | Check for useless assignments. |
| `atomic` | Check for common mistakes using the sync/atomic package. |
| `atomicalign` | Check for non-64-bits-aligned arguments to sync/atomic functions. |
| `bools` | Check for common mistakes involving boolean operators. |
| `buildtag` | Check `//go:build` and `// +build` directives. |
| `cgocall` | Detect some violations of the cgo pointer passing rules. Takes argument types from the cgo-processed files rather than type-checking the originals, so it can miss an argument cgo rewrites. |
| `composites` | Check for unkeyed composite literals. |
| `copylocks` | Check for locks erroneously passed by value. |
| `deepequalerrors` | Check for calls of reflect.DeepEqual on error values. |
| `defers` | Report common mistakes in defer statements. |
| `directive` | Check Go toolchain directives such as `//go:debug`. |
| `errorsas` | Report passing non-pointer or non-error values to errors.As. |
| `fieldalignment` | Find structs that would use less memory if their fields were sorted. |
| `framepointer` | Report assembly that clobbers the frame pointer before saving it. |
| `hostport` | Check format of addresses passed to net.Dial. |
| `httpmux` | Report using Go 1.22 enhanced ServeMux patterns in older Go versions. |
| `httpresponse` | Check for mistakes using HTTP responses. |
| `ifaceassert` | Detect impossible interface-to-interface type assertions. |
| `inline` | Report calls to functions, and uses of constants and type aliases, marked `//go:fix inline`. Without upstream's inliner it suggests no fixes, and reports some calls the inliner would skip. |
| `loopclosure` | Check references to loop variables from within nested functions. |
| `lostcancel` | Check cancel func returned by context.WithCancel is called. |
| `nilfunc` | Check for useless comparisons between functions and nil. |
| `nilness` | Check for redundant or impossible nil comparisons. |
| `printf` | Check consistency of Printf format strings and arguments. |
| `reflectvaluecompare` | Check for comparing reflect.Value values with == or reflect.DeepEqual. |
| `shadow` | Check for possible unintended shadowing of variables. |
| `shift` | Check for shifts that equal or exceed the width of the integer. |
| `sigchanyzer` | Check for unbuffered channel of os.Signal. |
| `slog` | Check for invalid structured logging calls. |
| `sortslice` | Check the argument type of sort.Slice. |
| `stdmethods` | Check signature of methods of well-known interfaces. |
| `stdversion` | Report uses of too-new standard library symbols. |
| `stringintconv` | Check for string(int) conversions. |
| `structtag` | Check that struct field tags conform to reflect.StructTag.Get. |
| `testinggoroutine` | Report calls to (*testing.T).Fatal from goroutines started by a test. |
| `tests` | Check for common mistaken usages of tests and examples. |
| `timeformat` | Check for calls of (time.Time).Format or time.Parse with 2006-02-01. |
| `unmarshal` | Report passing non-pointer or non-interface values to unmarshal. |
| `unreachable` | Check for unreachable code. |
| `unsafeptr` | Check for invalid conversions of uintptr to unsafe.Pointer. |
| `unusedresult` | Check for unused results of calls to some functions. |
| `unusedwrite` | Checks for unused writes. |
| `waitgroup` | Check for misuses of sync.WaitGroup. |

## Not ported

These golangci-lint linters are left out on purpose.

| Linter | Reason |
|---|---|
| `depguard`, `goheader`, `grouper`, `nonamedreturns` | GPL-3.0. A port would be a derived work, which this MIT-licensed library cannot include. |
| `musttag`, `sloglint` | MPL-2.0. A port would have to stay under MPL-2.0, unlike the rest of this MIT-licensed library. |
| `modernize` | Its analyzers ship with Go 1.26 and later; run `go fix -diff`. |
| `gofmt`, `goimports` | Formatters rather than linters; run the tools themselves. |
| `staticcheck`, `gocritic`, `gosec` | Large suites of many checks, too big to port; run the tools themselves. |
| `gochecksumtype` | `sumtype` covers the same check. |
| `arangolint`, `ginkgolinter`, `zerologlint` | Specific to one library. |
| `unqueryvet` | About 12,000 lines of code, too big to port for one check. |
| `findcall`, in `govet` | A demonstration analyzer that reports calls to a function by name. |

golangci-lint itself is also GPL-3.0, so the ports follow each upstream
linter's own code and match only golangci-lint's observable behaviour: its
defaults, options, and messages.
