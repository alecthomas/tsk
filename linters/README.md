# Linters

This library holds linters written for `tsk` and ports of golangci-lint's
linters. Add it to a project with `tsk get github.com/alecthomas/tsk//linters`.
Every linter runs once the library is imported, except those off by default;
turn off the ones you do not want with `disable` in `.tsk/config.toml`, and
turn on others with `enable`. `tsk config` documents each linter's options.

## Original linters

| Linter | Reports |
|---|---|
| `encapsulation` | Private-field access and construction outside a struct's API. |
| `lockguard` | Fields of structs with a mutex, and variables after one, accessed without holding it when they change after construction. |
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
its own in the `govet` group, so `disable`, `//nolint`, and options name the
analyzer, as in `[printf]`, or the group for all of them. They port the
analyzers of
[`golang.org/x/tools/go/analysis/passes`](https://pkg.go.dev/golang.org/x/tools/go/analysis/passes)
v0.50.0, BSD-3-Clause, including those `go vet` does not run, so `go vet` is
not needed alongside them. As in golangci-lint, `atomicalign`,
`deepequalerrors`, `fieldalignment`, `httpmux`, `nilness`,
`reflectvaluecompare`, `shadow`, `sortslice`, and `unusedwrite` are off by
default.

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

## Revive rules

These port the rules of [`revive`](https://github.com/mgechev/revive)
v1.17.0, MIT, which golangci-lint runs through its `revive` linter. Here each
rule is a linter of its own in the `revive` group, named after the rule in
snake_case, as in `var_naming`; `revive_atomic` avoids clashing with vet's
`atomic`. A rule's arguments are its linter's options, as in
`[line_length_limit]`. As in revive, only its default rules run unless
enabled. `struct_tag` includes a port of
[`fatih/structtag`](https://github.com/fatih/structtag) v1.2.0, BSD-3-Clause.

Unlike revive:

- Findings less confident than revive's default of 0.8 are never reported, as
  there is no `confidence` option.
- `//revive:disable` and `//revive:enable` comments are not applied; use
  `//nolint` with the linter or group name instead.
- Generated files are recognised as tsk recognises them, by a
  `// Code generated ... DO NOT EDIT.` line before the package clause, rather
  than on any line.

| Linter | Default | Description |
|---|---|---|
| `add_constant` | no | Suggests using constant for magic numbers and string literals. |
| `argument_limit` | no | Specifies the maximum number of arguments a function can receive. |
| `banned_characters` | no | Checks banned characters in identifiers. |
| `bare_return` | no | Warns on bare returns. |
| `blank_imports` | yes | Disallows blank imports. |
| `bool_literal_in_expr` | no | Suggests removing Boolean literals from logic expressions. |
| `call_to_gc` | no | Warns on explicit call to the garbage collector. |
| `cognitive_complexity` | no | Sets restriction for maximum Cognitive complexity. |
| `comment_spacings` | no | Warns on malformed comments. |
| `comments_density` | no | Enforces a minimum comment / code relation. |
| `confusing_naming` | no | Warns on methods with names that differ only by capitalization. |
| `confusing_results` | no | Suggests to name potentially confusing function results. |
| `constant_logical_expr` | no | Warns on constant logical expressions. |
| `context_as_argument` | yes | `context.Context` should be the first argument of a function. |
| `context_keys_type` | yes | Disallows the usage of basic types in `context.WithValue`. |
| `cyclomatic` | no | Sets restriction for maximum Cyclomatic complexity. |
| `datarace` | no | Spots potential dataraces. |
| `deep_exit` | no | Looks for program exits in funcs other than `main()` or `init()`. |
| `defer` | no | Warns on some [defer gotchas](https://blog.learngoprogramming.com/5-gotchas-of-defer-in-go-golang-part-iii-36a1ab3d6ef1). |
| `dot_imports` | yes | Forbids `.` imports. |
| `duplicated_imports` | no | Looks for packages that are imported two or more times. |
| `early_return` | no | Spots if-then-else statements where the predicate may be inverted to reduce nesting. |
| `empty_block` | yes | Warns on empty code blocks. |
| `empty_lines` | no | Warns when there are heading or trailing newlines in a block. |
| `enforce_map_style` | no | Enforces consistent usage of `make(map[type]type)` or `map[type]type{}` for map initialization. Does not affect `make(map[type]type, size)` constructions. |
| `enforce_repeated_arg_type_style` | no | Enforces consistent style for repeated argument and/or return value types. |
| `enforce_slice_style` | no | Enforces consistent usage of `make([]type, 0)` or `[]type{}` for slice initialization. Does not affect `make(map[type]type, non_zero_len, or_non_zero_cap)` constructions. |
| `enforce_switch_style` | no | Enforces consistent usage of `default` on `switch` statements. |
| `epoch_naming` | no | Enforces naming conventions for epoch time variables. |
| `error_naming` | yes | Naming of error variables. |
| `error_return` | yes | The error return parameter should be last. |
| `error_strings` | yes | Conventions around error strings. |
| `errorf` | yes | Should replace `errors.New(fmt.Sprintf())` with `fmt.Errorf()`. |
| `exported` | yes | Naming and commenting conventions on exported symbols. |
| `file_header` | no | Header which each file should have. |
| `file_length_limit` | no | Enforces a maximum number of lines per file. |
| `filename_format` | no | Enforces the formatting of filenames. |
| `flag_parameter` | no | Warns on boolean parameters that create a control coupling. |
| `forbidden_call_in_wg_go` | no | Warns on forbidden calls inside calls to wg.Go. |
| `function_length` | no | Warns on functions exceeding the statements or lines max. |
| `function_result_limit` | no | Specifies the maximum number of results a function can return. |
| `get_return` | no | Warns on getters that do not yield any result. |
| `identical_branches` | no | Spots if-then-else statements with identical `then` and `else` branches. |
| `identical_ifelseif_branches` | no | Spots `if ... else if` chains with identical branches. |
| `identical_ifelseif_conditions` | no | Spots identical conditions in `if ... else if` chains. |
| `identical_switch_branches` | no | Spots `switch` with identical branches. |
| `identical_switch_conditions` | no | Spots identical conditions in case clauses of `switch` statements. |
| `if_return` | no | Redundant if when returning an error. |
| `import_alias_naming` | no | Conventions around the naming of import aliases. |
| `import_shadowing` | no | Spots identifiers that shadow an import. |
| `imports_blocklist` | no | Disallows importing the specified packages. |
| `increment_decrement` | yes | Use `i++` and `i--` instead of `i += 1` and `i -= 1`. |
| `indent_error_flow` | yes | Prevents redundant else statements. |
| `inefficient_map_lookup` | no | Spots iterative searches for a key in a map. |
| `line_length_limit` | no | Specifies the maximum number of characters in a line, with optional per-line exclusions. |
| `marshal_receiver` | no | Checks receiver type consistency for common marshal/unmarshal methods. |
| `max_control_nesting` | no | Sets restriction for maximum nesting of control structures. |
| `max_public_structs` | no | The maximum number of public structs in a file. |
| `modifies_parameter` | no | Warns on assignments to function parameters. |
| `modifies_value_receiver` | no | Warns on assignments to value-passed method receivers. |
| `multiline_if_init` | no | Flags `if` statements whose init clause spans multiple lines. |
| `nested_structs` | no | Warns on structs within structs. |
| `optimize_operands_order` | no | Checks inefficient conditional expressions. |
| `package_comments` | yes | Package commenting conventions. |
| `package_directory_mismatch` | no | Checks that package name matches containing directory name. |
| `package_naming` | no | Checks that package names follow Go conventions and best practices. |
| `range` | yes | Prevents redundant variables when iterating over a collection. |
| `range_val_address` | no | Warns if address of range value is used dangerously. |
| `range_val_in_closure` | no | Warns if range value is used in a closure dispatched as goroutine. |
| `receiver_naming` | yes | Conventions around the naming of receivers. |
| `redefines_builtin_id` | yes | Warns on redefinitions of builtin identifiers. |
| `redundant_build_tag` | no | Warns about redundant `// +build` comment lines. |
| `redundant_import_alias` | no | Warns on import aliases matching the imported package name. |
| `revive_atomic` | no | Check for common mistaken usages of the `sync/atomic` package. |
| `string_format` | no | Warns on specific string literals that fail one or more user-configured regular expressions. |
| `string_of_int` | no | Warns on suspicious casts from int to string. |
| `struct_tag` | no | Checks common struct tags like `json`, `xml`, `yaml`. |
| `superfluous_else` | yes | Prevents redundant else statements (extends `indent_error_flow`). |
| `time_date` | no | Reports bad usage of `time.Date`. |
| `time_equal` | no | Suggests to use `time.Time.Equal` instead of `==` and `!=` for equality check time. |
| `time_naming` | yes | Conventions around the naming of time variables. |
| `unchecked_type_assertion` | no | Disallows type assertions without checking the result. |
| `unconditional_recursion` | no | Warns on function calls that will lead to (direct) infinite recursion. |
| `unexported_naming` | no | Warns on wrongly named un-exported symbols. |
| `unexported_return` | yes | Warns when a public return is from unexported type. |
| `unhandled_error` | no | Warns on unhandled errors returned by function calls. |
| `unnecessary_format` | no | Identifies calls to formatting functions where the format string does not contain any formatting verbs. |
| `unnecessary_if` | no | Identifies `if-else` statements that can be replaced by simpler statements. |
| `unnecessary_stmt` | no | Suggests removing or simplifying unnecessary statements. |
| `unreachable_code` | yes | Warns on unreachable code. |
| `unsecure_url_scheme` | no | Checks for usage of potentially unsecure URL schemes. |
| `unused_parameter` | yes | Suggests to rename or remove unused function parameters. |
| `unused_receiver` | no | Suggests to rename or remove unused method receivers. |
| `use_any` | no | Proposes to replace `interface{}` with its alias `any`. |
| `use_errors_new` | no | Spots calls to `fmt.Errorf` that can be replaced by `errors.New`. |
| `use_fmt_print` | no | Proposes to replace calls to built-in `print` and `println` with their equivalents from `fmt`. |
| `use_slices_concat` | no | Proposes to replace appends to an empty slice with a call to `slices.Concat`. |
| `use_slices_sort` | no | Proposes to replace calls to `sort.Ints`, `sort.Strings` and the like with their equivalents from `slices` package. |
| `use_waitgroup_go` | no | Proposes to replace `wg.Add ... go {... wg.Done ...}` idiom with `wg.Go`. |
| `useless_break` | no | Warns on useless `break` statements in case clauses. |
| `useless_fallthrough` | no | Warns on useless `fallthrough` statements in case clauses. |
| `var_declaration` | yes | Reduces redundancies around variable declaration. |
| `var_naming` | yes | Naming rules. |
| `waitgroup_by_value` | no | Warns on functions taking sync.WaitGroup as a by-value parameter. |

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
