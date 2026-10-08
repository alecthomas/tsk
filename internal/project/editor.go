package project

import (
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"slices"

	"github.com/alecthomas/errors"

	"github.com/alecthomas/tsktsk/internal/compile"
)

// WriteEditorFiles writes the host declarations to types/ in the scripts
// directory, and a tsconfig.json matching the options scripts are checked with.
func WriteEditorFiles(c Config) error {
	c, err := c.Resolve()
	if err != nil {
		return err
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
		},
		"include": []string{"**/*.ts"},
		"exclude": []string{"testdata"},
	}, "", "  ")
	if err != nil {
		return errors.Wrap(err, "encode tsconfig.json")
	}
	return errors.Wrap(os.WriteFile(filepath.Join(c.Dir, "tsconfig.json"), append(tsconfig, '\n'), 0o600), "write tsconfig.json")
}
