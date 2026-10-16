package project

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"

	"github.com/alecthomas/errors"
	. "github.com/alecthomas/types/optional"

	"github.com/alecthomas/tsk/internal/compile"
	"github.com/alecthomas/tsk/internal/config"
	"github.com/alecthomas/tsk/internal/engine"
	"github.com/alecthomas/tsk/internal/library"
)

// Get adds requested imports to the config file, then pins every import that
// is not replaced in the lock file, as pin describes. Requests are written to
// the config file without versions, so the lock file alone records them, and
// a version in the config file is always one written by hand. Each library
// the lock file adds, changes, or drops is reported to out with the analyzers
// the change adds or removes, because an update can enable new linters. c
// must be resolved.
func Get(ctx context.Context, logger *slog.Logger, c Config, cache *library.Cache, requests []library.Import, out io.Writer) error {
	text, err := os.ReadFile(c.Config)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.Wrap(err, "read config")
	}
	file, err := config.Parse(c.Config, string(text))
	if err != nil {
		return errors.WithStack(err)
	}
	imports := slices.Clone(file.Imports)
	for _, request := range requests {
		request.Version = None[string]()
		i := slices.IndexFunc(imports, func(imported library.Import) bool { return imported.Path() == request.Path() })
		if i < 0 {
			imports = append(imports, request)
		} else {
			imports[i] = request
		}
	}
	if err := library.CheckImports(imports); err != nil {
		return errors.WithStack(err)
	}
	previous, err := library.LoadLock(c.LockFile())
	if err != nil {
		return errors.WithStack(err)
	}
	var lock library.Lock
	replaced := map[string]string{}
	for _, imported := range imports {
		request, isRequested := requested(requests, imported.Path())
		// A replaced import loads from its directory, so it has nothing to pin.
		if replacement, isReplaced := file.Replacement(imported); isReplaced {
			if isRequested {
				return errors.Errorf("%q is replaced, so it cannot be pinned", imported)
			}
			dir, err := replacementDir(c, replacement)
			if err != nil {
				return errors.Wrapf(err, "replace %q", imported)
			}
			replaced[imported.Path()] = dir
			continue
		}
		if isRequested {
			imported = request
		}
		locked, err := pin(ctx, cache, previous, imported, isRequested, len(requests) == 0, out)
		if err != nil {
			return err
		}
		lock.Imports = append(lock.Imports, locked)
	}
	if err := reportChanges(ctx, logger, cache, previous, lock, replaced, out); err != nil {
		return err
	}
	if !slices.Equal(imports, file.Imports) {
		updated, err := config.SetImports(text, imports)
		if err != nil {
			return errors.Wrapf(err, "%s", c.Config)
		}
		if err := os.MkdirAll(filepath.Dir(c.Config), 0o750); err != nil {
			return errors.Wrap(err, "create config directory")
		}
		if err := os.WriteFile(c.Config, updated, 0o600); err != nil {
			return errors.Wrap(err, "write config")
		}
	}
	return errors.WithStack(lock.Save(c.LockFile()))
}

func requested(requests []library.Import, path string) (request library.Import, ok bool) {
	i := slices.IndexFunc(requests, func(request library.Import) bool { return request.Path() == path })
	if i < 0 {
		return library.Import{}, false
	}
	return requests[i], true
}

// pin resolves an import to the version it names, or the latest without one.
// Unless it is requested or updateAll is set, an import its lock entry still
// pins keeps that entry, so only imports added or edited by hand resolve.
// With updateAll, an import held unchanged by its version is reported to out,
// so the user knows why it did not update.
func pin(ctx context.Context, cache *library.Cache, previous library.Lock, imported library.Import, isRequested, updateAll bool, out io.Writer) (library.Locked, error) {
	old, wasLocked := previous.Find(imported.Path())
	if !isRequested && !updateAll && wasLocked && old.Pins(imported) {
		return old, nil
	}
	locked, err := cache.Resolve(ctx, imported)
	if err != nil {
		return library.Locked{}, errors.WithStack(err)
	}
	if _, fixed := imported.Version.Get(); fixed && updateAll && wasLocked && old.Commit == locked.Commit {
		fmt.Fprintf(out, "keep %s, its version is set in the config\n", locked) //nolint:errcheck // Output is best effort.
	}
	return locked, nil
}

// reportChanges writes each library whose commit changed between the lock
// files, with the analyzers it adds and removes. A library that leaves the
// lock file because it is now replaced compares with its replacement in
// replaced, keyed by path, so it does not read as removed.
func reportChanges(ctx context.Context, logger *slog.Logger, cache *library.Cache, previous, current library.Lock, replaced map[string]string, out io.Writer) error {
	paths := make([]string, 0, len(current.Imports)+len(previous.Imports))
	for _, locked := range slices.Concat(current.Imports, previous.Imports) {
		if !slices.Contains(paths, locked.Path()) {
			paths = append(paths, locked.Path())
		}
	}
	for _, path := range paths {
		old, wasLocked := previous.Find(path)
		locked, isLocked := current.Find(path)
		dir, isReplaced := replaced[path]
		var before, after []string
		var err error
		switch {
		case wasLocked && isLocked && old.Commit == locked.Commit:
			continue
		case wasLocked && isLocked:
			fmt.Fprintf(out, "update %s => %s\n", old, locked.Version+" ("+locked.Short()+")") //nolint:errcheck // Output is best effort.
		case isLocked:
			fmt.Fprintf(out, "add %s\n", locked) //nolint:errcheck // Output is best effort.
		case isReplaced:
			fmt.Fprintf(out, "replace %s => %s\n", old, dir) //nolint:errcheck // Output is best effort.
		default:
			fmt.Fprintf(out, "remove %s\n", old) //nolint:errcheck // Output is best effort.
		}
		if wasLocked {
			if before, err = lockedAnalyzerNames(ctx, logger, cache, old); err != nil {
				return err
			}
		}
		switch {
		case isLocked:
			after, err = lockedAnalyzerNames(ctx, logger, cache, locked)
		case isReplaced:
			after, err = analyzerNames(ctx, logger, path, dir)
		}
		if err != nil {
			return err
		}
		for _, name := range after {
			if !slices.Contains(before, name) {
				fmt.Fprintf(out, "  + %s\n", name) //nolint:errcheck // Output is best effort.
			}
		}
		for _, name := range before {
			if !slices.Contains(after, name) {
				fmt.Fprintf(out, "  - %s\n", name) //nolint:errcheck // Output is best effort.
			}
		}
	}
	return nil
}

// lockedAnalyzerNames returns the analyzers' names of a locked library.
func lockedAnalyzerNames(ctx context.Context, logger *slog.Logger, cache *library.Cache, locked library.Locked) ([]string, error) {
	dir, err := cache.Snapshot(ctx, locked)
	if err != nil {
		return nil, errors.WithStack(err)
	}
	names, err := analyzerNames(ctx, logger, locked.Path(), dir)
	return names, errors.Wrapf(err, "load %q", locked)
}

// analyzerNames loads the library at path from dir on its own and returns
// its analyzers' names.
func analyzerNames(ctx context.Context, logger *slog.Logger, path, dir string) ([]string, error) {
	e, err := engine.Load(ctx, logger, []compile.Source{{Name: path, FS: os.DirFS(dir), Library: true}})
	if err != nil {
		return nil, errors.WithStack(err)
	}
	return e.Names(), nil
}
