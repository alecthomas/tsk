# Architecture

- Put each executable entry point in `cmd/<command>`.
- For each binary, add a symlink named after the binary in `./scripts` pointing to `tsk`.
- Keep all initialisation and bootstrap code in the main entry point.
- Do not put application logic in main entry points.
- Do not use global state outside main entry points.
- Read environment variables only in main entry points, then pass configuration explicitly.
- Each package that exposes command-line options owns its Kong-tagged `Config` type.
- Embed package configs in CLI commands with `embed:""`; do not pre-initialise CLI defaults because Kong resets them.
- Pass the complete parsed config to the package constructor instead of unpacking individual fields.
- Use `kong.ApplyDefaults()` in config constructors so Kong tags remain the single source of default values.
- Define config validation as a `Validate()` method on the package-owned `Config` type.
- Put all other code in the top-level `internal` directory unless it is explicitly part of a public API.

# Compatibility

- While the version is 0.x.y, make breaking changes freely. Do not add backwards-compatibility shims, deprecation paths, or migration code.

# Automation

- Use `bit` and define tasks in `BUILD.bit` for all automation that would normally go in a Makefile, Justfile, or other build file.
- Run `bit -s <provider>` before adding build configuration so the most specific provider and correct fields are used.
- Run tests, linting, and formatting through `bit` targets instead of invoking the underlying commands manually.
- All tools used in build files or documentation must be installed in the repository's Hermit environment.
- Invoke commands from `scripts` by name. Never prefix them with the repository-relative scripts path because Hermit adds that directory to `PATH`.

# Documentation

- Do not modify `README.md` unless the user explicitly requests it.
- Put developer workflow documentation, such as building, testing, and running locally, in `CONTRIBUTING.md`.
- Put design documents, implementation plans, and other documents that fit neither `README.md` nor `CONTRIBUTING.md` in `docs/`.

# Commits and pull requests

- Always use Conventional Commits for commit messages and pull request titles.
- Keep commit messages and pull request titles and descriptions succinct and in plain English. Avoid jargon.
- Explain why the change is needed, not what changed.

# Go conventions

- Use `log/slog` for logging.
- Keep a type and all of its methods in the same file. Do not split a type's
  methods across multiple files.
- Wrap errors with `github.com/alecthomas/errors`.
- Name every input parameter in function, method, and interface signatures.
- Name result parameters when intrinsic types such as `bool`, `int`, or `string`
  do not convey their meaning. Do not use naked returns.
- Keep every comment to at most two lines.
- Document every public symbol.

# Optional values

- Use `github.com/alecthomas/types/optional.Option[T]` for any value that may be
  semantically absent, instead of a nil pointer, interface, func, channel,
  slice, or map, or a separate `present` flag.
- Use a plain slice or map when absent and empty mean the same thing.
- Dot-import it as `. "github.com/alecthomas/types/optional"` and write
  `Option[T]`, `Some(value)`, and `None[T]()`. It is the only allowed dot import.
- Keep Go's `(value, ok)` return idiom for lookups instead of returning `Option`.
- Keep nil checks on required arguments; those values are not optional.
- Read values with `Get()` or `Default()` and handle the absent case. Never call
  `MustGet()` outside tests; the linter rejects it.
- `bit lint-optional` reports nil used as an absent value. Keep an intentional
  nil with a `//nolint:optionalnil // <reason>` comment on or above its line.
- Tag optional JSON fields with `omitzero`, not `omitempty`.
- `Option` decodes JSON with `json.Unmarshal`, ignoring decoder settings such as
  `DisallowUnknownFields`. A type held in an `Option` must enforce strict
  decoding in its own `UnmarshalJSON`.

# Go testing

- Use `github.com/alecthomas/assert/v2` for assertions. Remember that
  `assert.Equal()` performs a deep comparison.
- Compare whole objects rather than individual fields. Exclude dynamic values
  with `assert.Equal(t, expected, actual, assert.Exclude[T]())`.
- Use table-driven tests when cases can be parameterized on data. Otherwise,
  create distinct test functions.
- Name Go test functions and subtests in UpperCamelCase. Never use underscores
  in test function names.
- Update an existing Go test when appropriate instead of creating a new one.
- Run necessary tests with `go test -timeout 30s`. Do not generally use `-v`.
