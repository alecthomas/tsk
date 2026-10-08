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
// then pins every import in the lock file. Requested imports are resolved
// again; others keep their locked commit unless their version changed. Each
// library the lock file adds, changes, or drops is reported to out with the
// analyzers the change adds or removes, because an update can enable new
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
	for i, imported := range imports {
		locked, err := pin(ctx, cache, previous, imported, requested(requests, imported.Path()))
		if err != nil {
			return err
		}
		imports[i].Version = Some(locked.Version)
		lock.Imports = append(lock.Imports, locked)
	}
	if err := reportChanges(ctx, logger, cache, previous, lock, out); err != nil {
		return err
	}
	if len(requests) > 0 {
		updated, err := config.SetImports(text, imports)
		if err != nil {
			return errors.Wrapf(err, "%s", c.Config)
		}
		if err := os.MkdirAll(filepath.Dir(c.Config), 0o750); err != nil {
			return errors.Wrap(err, "create config directory")
		}
		if err := os.WriteFile(c.Config, updated, 0o600); err != nil { //nolint:gosec // The config path is the user's own, from --config or discovery.
			return errors.Wrap(err, "write config")
		}
	}
	return errors.WithStack(lock.Save(c.LockFile()))
}

func requested(requests []library.Import, path string) bool {
	return slices.ContainsFunc(requests, func(request library.Import) bool { return request.Path() == path })
}

// pin keeps an import's locked commit while the import is unchanged, unless
// it was requested, and otherwise resolves the version again.
func pin(ctx context.Context, cache *library.Cache, previous library.Lock, imported library.Import, requested bool) (library.Locked, error) {
	if old, wasLocked := previous.Find(imported.Path()); wasLocked && !requested && old.Import() == imported {
		return old, nil
	}
	locked, err := cache.Resolve(ctx, imported)
	return locked, errors.WithStack(err)
}

// reportChanges writes each library whose commit changed between the lock
// files, with the analyzers it adds and removes.
func reportChanges(ctx context.Context, logger *slog.Logger, cache *library.Cache, previous, current library.Lock, out io.Writer) error {
	paths := make([]string, 0, len(current.Imports)+len(previous.Imports))
	for _, locked := range slices.Concat(current.Imports, previous.Imports) {
		if !slices.Contains(paths, locked.Path()) {
			paths = append(paths, locked.Path())
		}
	}
	for _, path := range paths {
		old, wasLocked := previous.Find(path)
		locked, isLocked := current.Find(path)
		var before, after []string
		var err error
		switch {
		case wasLocked && isLocked && old.Commit == locked.Commit:
			continue
		case wasLocked && isLocked:
			fmt.Fprintf(out, "update %s => %s\n", old, locked.Version+" ("+locked.Short()+")") //nolint:errcheck // Output is best effort.
		case isLocked:
			fmt.Fprintf(out, "add %s\n", locked) //nolint:errcheck // Output is best effort.
		default:
			fmt.Fprintf(out, "remove %s\n", old) //nolint:errcheck // Output is best effort.
		}
		if wasLocked {
			if before, err = analyzerNames(ctx, logger, cache, old); err != nil {
				return err
			}
		}
		if isLocked {
			if after, err = analyzerNames(ctx, logger, cache, locked); err != nil {
				return err
			}
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

// analyzerNames loads a library on its own and returns its analyzers' names.
func analyzerNames(ctx context.Context, logger *slog.Logger, cache *library.Cache, locked library.Locked) ([]string, error) {
	dir, err := cache.Snapshot(ctx, locked)
	if err != nil {
		return nil, errors.WithStack(err)
	}
	e, err := engine.Load(ctx, logger, []compile.Source{{Name: locked.Path(), FS: os.DirFS(dir), Library: true}})
	if err != nil {
		return nil, errors.Wrapf(err, "load %s", locked)
	}
	return e.Names(), nil
}
