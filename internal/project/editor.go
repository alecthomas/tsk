package project

import (
	"context"
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"slices"

	"github.com/alecthomas/errors"

	"github.com/alecthomas/tsk/internal/compile"
	"github.com/alecthomas/tsk/internal/config"
	"github.com/alecthomas/tsk/internal/library"
)

// WriteEditorFiles writes the host declarations to types/ in the scripts
// directory, and a tsconfig.json matching the options scripts are checked
// with. Library imports map to the libraries' snapshots in the cache, or their
// replacements, so the file is specific to this machine. c must be resolved.
func WriteEditorFiles(ctx context.Context, c Config, cache *library.Cache) error {
	file, err := config.Load(c.Config)
	if err != nil {
		return errors.WithStack(err)
	}
	libraries, err := libraryDirs(ctx, c, file, cache)
	if err != nil {
		return err
	}
	paths := map[string][]string{}
	for _, loaded := range libraries {
		paths[loaded.imported.Path()+"/*"] = []string{filepath.ToSlash(loaded.dir) + "/*"}
	}
	declarations, err := compile.Declarations()
	if err != nil {
		return errors.WithStack(err)
	}
	types := filepath.Join(c.Dir, "types")
	if err := os.MkdirAll(types, 0o750); err != nil {
		return errors.Wrap(err, "create types directory")
	}
	for _, name := range slices.Sorted(maps.Keys(declarations)) {
		if err := os.WriteFile(filepath.Join(types, name), []byte(declarations[name]), 0o600); err != nil {
			return errors.Wrapf(err, "write %s", name)
		}
	}
	tsconfig, err := json.MarshalIndent(map[string]any{
		"compilerOptions": map[string]any{
			"strict":                     true,
			"noEmit":                     true,
			"target":                     "ES2020",
			"lib":                        []string{"ES2020", "ES2025.Iterator"},
			"types":                      []string{},
			"module":                     "ESNext",
			"moduleResolution":           "bundler",
			"isolatedModules":            true,
			"allowImportingTsExtensions": true,
			"paths":                      paths,
		},
		"include": []string{"**/*.ts"},
		"exclude": []string{"testdata"},
	}, "", "  ")
	if err != nil {
		return errors.Wrap(err, "encode tsconfig.json")
	}
	return errors.Wrap(os.WriteFile(filepath.Join(c.Dir, "tsconfig.json"), append(tsconfig, '\n'), 0o600), "write tsconfig.json")
}
