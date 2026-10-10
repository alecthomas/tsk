# Linter libraries

## Summary

A linter library is a directory of scripts in a git repository, shared between
projects. A project lists the libraries it uses in `.tsk/config.toml`, and
`tsk get` pins each to a commit in a lock file and downloads it. Every analyzer
in a listed library is enabled, as if its scripts were in `.tsk/`.

Libraries are fetched with the system `git` into a cache shared by every
project, modelled on Go's module cache. Each library at each commit is
extracted once, read-only, and loaded from there.

The core decisions:

1. **Listing a library enables it.** A library is a bundle of analyzers, not
   a set of modules to pick from. Unwanted analyzers are turned off with
   `disable`.
2. **Pins are commits.** The config names a version; the lock file records the
   commit it resolved to. A commit identifies the exact file tree, so no
   content hash is needed.
3. **No transitive imports.** A library may not import another library, so
   there is no manifest and no version selection.
4. **No built-in linters.** tsk's own linters are a library in this
   repository's `linters/`, so they are opt-in like any other.

## Declaring libraries

`config.toml` gains an `imports` setting listing libraries as
`<repository>@<version>[//<dir>]`. A version is a tag, a branch, or a commit.
No import may lie within another, as `github.com/acme/linters@v1//strict` lies
within `github.com/acme/linters@v1`, because both would hold the same scripts.

The lock file, `lock.toml` beside `config.toml`, maps each import to the full
commit hash its version resolved to. It is written only by `tsk get` and
should be committed.

Every command that loads scripts checks that the lock file covers exactly the
listed imports at their listed versions. A mismatch is an error asking the user
to run `tsk get`, so editing `imports` by hand is safe.

## Replacing imports

A `replace` setting maps imports, written without a version, to local
directories relative to `config.toml`, as Go's `replace` directive does:

```toml
replace = { "github.com/acme/linters//strict" = "../linters/strict" }
```

A replaced import loads from its directory, read on every run, under the same
rules as any library. It is never fetched or locked, so `tsk get` skips it and
the lock check ignores it, and an unpublished library works. Its import still
needs a version, so removing the replacement and running `tsk get` pins it. A
replacement must name a listed import, so a misspelt one is an error.

`replace` lives in `config.toml` and is committed, because a repository may
need it permanently: this one imports its own `linters/` and replaces it, so
`bit lint-tsk` checks each commit with the linters in that commit. The cost,
as in Go, is that a replacement meant only for one machine can be committed by
mistake.

## Import paths

An import names a repository, a version, and an optional directory within the
repository, after `//`, as in `github.com/acme/linters@v1.2.0//strict`. The
`//` separator follows Terraform and go-getter. Git refs cannot contain `//`,
so a branch such as `feature/x` is never mistaken for the directory. Without a
directory, the library is the repository's root.

The repository is a host name followed by a path, fetched from
`https://<repository>`, so any host and nesting works, such as GitLab
subgroups. Users reach private repositories over SSH with git's own
`insteadOf` rewrites and credential helpers, which `git` applies unchanged.

A library's import path is its repository joined with its directory, such as
`github.com/acme/linters/strict`. It names the library's scripts, so project
scripts import them by it.

The library's scripts are collected as `.tsk/` scripts are: every `.ts` file,
skipping `testdata/` and `types/`. A library has no config file; the importing
project configures its analyzers.

## Commands

- `tsk get [<repository>[@<version>][//<dir>]...]` adds or updates the named
  libraries in `imports`, resolves every import against its repository,
  rewrites the lock file, and downloads missing snapshots. Without arguments
  it only reconciles the lock file with `imports`, so a removed import is
  dropped. An import without a version resolves to the highest semver tag, or
  the default branch when there is none. Each changed library prints the analyzers the change adds or
  removes, because an update can enable new linters.
- `tsk sync` downloads every locked snapshot missing from the cache, for CI
  and offline preparation.
- `lint`, `test`, `check`, `config`, and `list` download a locked snapshot
  that is missing. Otherwise they never touch the network.
- `tsk list` prints one line per analyzer: its name, whether it is enabled,
  its source, and the first line of its documentation. The source is
  a library's path and short commit, a replaced library's directory, or a
  project script's path.
  It reads what `Project.Describe` already gathers for `tsk config`.
- `tsk test` tests only the project's analyzers. A library tests itself in its
  own repository with `tsk test --dir <library>`.

## Cache

The cache is `os.UserCacheDir()/tsk`, such as `~/Library/Caches/tsk` on macOS.
`--cache`, or `TSK_CACHE`, overrides it. `disable` keeps the default location
for libraries but does not cache lint results.

```text
<cache>/
├── git/github.com/acme/linters.git/          bare mirror, one per repository
├── git/github.com/acme/linters.git.lock      serializes work on the mirror
├── src/github.com/acme/linters@3f9c2e1…/     one library at one commit
├── src/github.com/acme/linters/strict@3f9c2e1…/
├── lint/                                       cached lint results, per package
└── tmp/                                        staging for new snapshots
```

**Mirrors.** `git/` holds a bare clone per repository. Resolving versions and
fetching commits happens only there, so updates download only what changed and
work with any git server. Clones are blobless, with `--filter=blob:none`: they
hold every commit and tree but no file contents, which extracting a snapshot
fetches for its commit and directory only. A server without filter support
sends everything instead. Fetches take the mirror's lock file, because
concurrent `git fetch` runs into one repository are not safe.

**Snapshots.** `src/` holds each library at each commit, keyed by its full
import path and full commit hash, never by a tag or branch, because those
move. A snapshot is exported with `git archive <commit> <directory>` into
`tmp/`, holding the mirror's lock, and renamed into place. The rename is atomic
on one file system, so readers need no lock and see a whole snapshot or none.
Only regular files are extracted, read-only. Directories stay writable so the
cache can be deleted with ordinary tools.

**Paths.** Uppercase letters are escaped as `!` and the lowercase letter, as
Go does, so `github.com/Acme/linters` is stored as `github.com/!acme/linters`.
macOS and Windows file systems are case-insensitive by default, so otherwise
`Acme` and `acme` would collide. The `.git` and `@<commit>` suffixes ensure
that no entry is nested in another, which Go guards against for security.

Everything in the cache can be rebuilt, so deleting it is always safe.

## Loading

Sources load in order: libraries in `imports` order, then the project's
`.tsk/`. Every module of every source is evaluated.

- An analyzer in the project replaces a library analyzer of the same name.
  Two libraries defining the same name is an error naming both.
- Project scripts may import library modules by path, such as
  `github.com/acme/linters/helpers`, for shared code and `requires` handles.
  A library script may import only within its own library, by relative path.

This changes the loader in three places:

- `compile.Source` names may contain `/`, since libraries are named by import
  path. Module names stay `<source>/<file>`.
- The runtime resolver can no longer find a module's source by cutting its name
  at the first `/`. The compiler records each module's source, and the
  resolver confines relative imports to it. Bare specifiers resolve to the
  library whose path they start with; sources may not overlap, so there is at
  most one.
- The TypeScript program resolves library paths the same way, through `paths`
  mappings onto each library's virtual directory.

`tsk init` writes the same `paths` mappings into `tsconfig.json`, pointing at
the snapshots in the cache, so editors resolve library imports. Those paths are
specific to the machine, and `tsk init` must be rerun after `tsk get`.

## Security

Library scripts run with the same restrictions as project scripts: they can
read the file system but not write to it or reach the network. Pinning commits
means a library changes only when the user runs `tsk get`.

## Deferred

- **Transitive imports.** These need a library manifest declaring imports, and
  minimal version selection, which in turn needs libraries to require semver
  tags. Nothing above blocks adding them.
- **Minimum tsk version.** A library cannot yet declare the tsk version it
  needs, so an incompatible one fails with type errors.
- **Cache cleanup**, until caches grow large in practice.
