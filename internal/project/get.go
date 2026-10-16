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

// Get adds requested imports to the config file or changes their versions,
// then pins every import that is not replaced in the lock file. Without
// requests, every import updates to its latest version, as pin describes.
// Each library the lock file adds, changes, or drops is reported to out with
// the analyzers the change adds or removes, because an update can enable new
// linters. c must be resolved.
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
	for i, imported := range imports {
		// A replaced import loads from its directory, so it has nothing to pin.
		if replacement, isReplaced := file.Replacement(imported); isReplaced {
			if _, hasVersion := imported.Version.Get(); !hasVersion {
				return errors.Errorf("%q is replaced, so its latest version cannot be resolved; give a version", imported)
			}
			dir, err := replacementDir(c, replacement)
			if err != nil {
				return errors.Wrapf(err, "replace %q", imported)
			}
			replaced[imported.Path()] = dir
			continue
		}
		locked, err := pin(ctx, cache, previous, imported, requested(requests, imported.Path()), len(requests) == 0, out)
		if err != nil {
			return err
		}
		imports[i].Version = Some(locked.Version)
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

func requested(requests []library.Import, path string) bool {
	return slices.ContainsFunc(requests, func(request library.Import) bool { return request.Path() == path })
}

// pin resolves a requested import's version. With updateAll, an import still
// matching its lock entry resolves to the latest version, while one edited by
// hand keeps its version, reported to out, because the edit is the user's
// choice. Otherwise an unchanged import keeps its locked commit.
func pin(ctx context.Context, cache *library.Cache, previous library.Lock, imported library.Import, requested, updateAll bool, out io.Writer) (library.Locked, error) {
	old, wasLocked := previous.Find(imported.Path())
	unchanged := wasLocked && old.Import() == imported
	switch {
	case requested:
	case unchanged && updateAll:
		imported.Version = None[string]()
	case unchanged:
		return old, nil
	case updateAll && wasLocked:
		fmt.Fprintf(out, "keep %s, edited by hand\n", imported) //nolint:errcheck // Output is best effort.
	}
	locked, err := cache.Resolve(ctx, imported)
	return locked, errors.WithStack(err)
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
