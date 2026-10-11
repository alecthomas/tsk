package golangci_test

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/alecthomas/assert/v2"
	. "github.com/alecthomas/types/optional"
	ts "github.com/microsoft/TypeScript/tsc/shim/typescript"
	"go.yaml.in/yaml/v3"

	"github.com/alecthomas/tsk/internal/docs"
	"github.com/alecthomas/tsk/internal/golangci"
)

func analyzers() []docs.Analyzer {
	strings := ts.ArrayShape{Element: ts.StringShape{}}
	return []docs.Analyzer{
		{Name: "errcheck", Config: Some(docs.Config{
			Shape:    ts.ObjectShape{Properties: []ts.Property{{Name: "checkBlank", Shape: ts.BooleanShape{}}}},
			Defaults: map[string]any{"checkBlank": false},
		})},
		{Name: "funlen", Config: Some(docs.Config{
			Shape:    ts.ObjectShape{Properties: []ts.Property{{Name: "lines", Shape: ts.NumberShape{}}, {Name: "statements", Shape: ts.NumberShape{}}}},
			Defaults: map[string]any{"lines": 60.0, "statements": 40.0},
		})},
		{Name: "revive", Config: Some(docs.Config{
			Shape: ts.ObjectShape{Properties: []ts.Property{
				{Name: "enable", Shape: strings},
				{Name: "disable", Shape: strings},
				{Name: "enableDefaultRules", Shape: ts.BooleanShape{}},
				{Name: "directives", Shape: strings},
				{Name: "dotImports", Shape: ts.ObjectShape{Properties: []ts.Property{{Name: "allowedPackages", Shape: strings}}}},
			}},
			Defaults: map[string]any{},
		})},
		{Name: "exhaustruct", Config: Some(docs.Config{
			Shape:    ts.ObjectShape{Properties: []ts.Property{{Name: "ignorePatterns", Shape: strings}, {Name: "allowEmptyReturns", Shape: ts.BooleanShape{}}}},
			Defaults: map[string]any{"ignorePatterns": []any{}, "allowEmptyReturns": false},
		})},
		// Not a golangci-lint linter, so it stays enabled.
		{Name: "encapsulation"},
		{Name: "unused"},
	}
}

func TestConvert(t *testing.T) {
	tests := []struct {
		name     string
		config   string
		expected golangci.Result
		err      string
	}{
		{
			name: "StandardWithEnableAndDisable",
			config: `
version: "2"
linters:
  enable: [funlen, gocritic]
  disable: [errcheck]
`,
			expected: golangci.Result{
				Settings: map[string]any{"disable-all": true, "enable": []string{"encapsulation", "funlen", "unused"}},
				Tables:   map[string]map[string]any{},
				Warnings: []string{"not available in tsk, so not enabled: gocritic, govet, ineffassign, staticcheck"},
			},
		},
		{
			name: "AllWithDisable",
			config: `
version: "2"
linters:
  default: all
  disable: [funlen, gocritic]
`,
			expected: golangci.Result{
				Settings: map[string]any{"disable": []string{"funlen"}},
				Tables:   map[string]map[string]any{},
			},
		},
		{
			name: "Settings",
			config: `
version: "2"
linters:
  default: none
  settings:
    funlen:
      lines: 100
      ignore-comments: true
    errcheck:
      check-blank: "yes"
    gocritic:
      enabled-checks: [all]
`,
			expected: golangci.Result{
				Settings: map[string]any{"disable-all": true, "enable": []string{"encapsulation"}},
				Tables:   map[string]map[string]any{"funlen": {"lines": int64(100)}},
				Warnings: []string{
					"linters.settings.errcheck.check-blank is not imported: errcheck.check-blank: expected a boolean, got a string",
					"linters.settings.funlen.ignore-comments is not imported: funlen.ignore-comments: unknown key",
					"linters.settings.gocritic is not imported: tsk has no gocritic analyzer",
				},
			},
		},
		{
			name: "ReviveRules",
			config: `
version: "2"
linters:
  default: all
  settings:
    revive:
      enable-default-rules: true
      severity: error
      directives:
        - name: specify-disable-reason
      rules:
        - name: dot-imports
          arguments:
            - allowed-packages: [example.com/opt]
        - name: line-length-limit
          arguments: [100]
        - name: exported
          disabled: true
`,
			expected: golangci.Result{
				Settings: map[string]any{},
				Tables: map[string]map[string]any{"revive": {
					"enable":               []any{"dot-imports", "line-length-limit"},
					"disable":              []any{"exported"},
					"enable-default-rules": true,
					"directives":           []any{"specify-disable-reason"},
					"dot-imports":          map[string]any{"allowed-packages": []any{"example.com/opt"}},
				}},
				Warnings: []string{
					"revive rule line-length-limit: positional arguments are not imported; set [revive.line-length-limit] options instead",
					"linters.settings.revive.severity is not imported: tsk has no equivalent",
				},
			},
		},
		{
			name: "ExclusionsAndRun",
			config: `
version: "2"
run:
  tests: false
  timeout: 5m
linters:
  default: all
  exclusions:
    generated: disable
    presets: [comments]
    paths: ['lib/bad\.go']
    rules:
      - path: _test\.go
        linters: [funlen, gocritic]
      - text: "should have a package comment"
        linters: [revive, gocritic]
      - path-except: _test\.go
        source: "^//go:generate "
      - text: "G704:"
        linters: [gosec]
      - linters: [funlen]
formatters:
  enable: [gofmt]
`,
			expected: golangci.Result{
				Settings: map[string]any{
					"no-tests":       true,
					"lint-generated": true,
					"skip-tests":     []string{"funlen"},
					"exclude-paths":  []string{`lib/bad\.go`},
					"exclude": []any{
						map[string]any{"linters": []string{"revive"}, "text": "should have a package comment"},
						map[string]any{"path-except": `_test\.go`, "source": "^//go:generate "},
					},
				},
				Tables: map[string]map[string]any{},
				Warnings: []string{
					"formatters are not imported: tsk does not format code",
					"linters.exclusions.presets are not imported: tsk has no presets; add exclude rules for the findings they dropped",
					`linters.exclusions.rules[4] {"linters":["funlen"]} is not imported: it names only linters; disable them instead`,
					"run.timeout is not imported: tsk has no equivalent",
				},
			},
		},
		{
			// tsk's exhaustruct is version 5, golangci-lint's exhaustruct_v5.
			name: "Exhaustruct",
			config: `
version: "2"
linters:
  default: none
  enable: [exhaustruct_v5]
  settings:
    exhaustruct:
      exclude: ['.+/cobra\.Command$']
      allow-empty-returns: true
    exhaustruct_v5:
      ignore-patterns: ['.+/x\.Y$']
`,
			expected: golangci.Result{
				Settings: map[string]any{"disable-all": true, "enable": []string{"encapsulation", "exhaustruct"}},
				Tables: map[string]map[string]any{"exhaustruct": {
					"allow-empty-returns": true,
					"ignore-patterns":     []any{`.+/x\.Y$`},
				}},
				Warnings: []string{
					"linters.settings.exhaustruct.exclude is not imported: it is an exhaustruct v4 option, and tsk's exhaustruct is v5, which has ignore-patterns instead",
				},
			},
		},
		{
			name:   "Version1",
			config: "linters:\n  enable: [funlen]\n",
			err:    "only golangci-lint v2 configs can be imported; convert this one with golangci-lint migrate",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var decoded map[string]any
			assert.NoError(t, yaml.Unmarshal([]byte(test.config), &decoded))
			// The YAML decoder types integers as int; Import normalises them.
			normalise(decoded)
			result, err := golangci.Convert(decoded, analyzers())
			if test.err != "" {
				assert.EqualError(t, err, test.err)
				return
			}
			assert.NoError(t, err)
			assert.Equal(t, test.expected, result)
		})
	}
}

// normalise converts the YAML decoder's int to int64 in place.
func normalise(value any) {
	switch value := value.(type) {
	case map[string]any:
		for key, element := range value {
			if number, ok := element.(int); ok {
				value[key] = int64(number)
				continue
			}
			normalise(element)
		}
	case []any:
		for i, element := range value {
			if number, ok := element.(int); ok {
				value[i] = int64(number)
				continue
			}
			normalise(element)
		}
	}
}

func TestImport(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".tsk", "config.toml")
	assert.NoError(t, os.MkdirAll(filepath.Dir(path), 0o750))
	existing := "imports = [\"github.com/acme/linters@v1.0.0\"]\n" +
		"replace = { \"github.com/acme/linters\" = \"../linters\" }\n"
	assert.NoError(t, os.WriteFile(path, []byte(existing), 0o600))
	golangciConfig := "version: \"2\"\nlinters:\n  default: all\n  settings:\n    funlen:\n      lines: 100\n    gocritic: {}\n"
	assert.NoError(t, os.WriteFile(filepath.Join(dir, ".golangci.yml"), []byte(golangciConfig), 0o600))
	log := slog.New(slog.DiscardHandler)

	var warnings bytes.Buffer
	assert.NoError(t, golangci.Import(log, &warnings, golangci.Config{}, dir, path, analyzers()))
	written, err := os.ReadFile(path)
	assert.NoError(t, err)
	assert.Equal(t, `# Imported from .golangci.yml by tsk config import.

imports = ['github.com/acme/linters@v1.0.0']

[replace]
'github.com/acme/linters' = '../linters'

[funlen]
lines = 100
`, string(written))
	assert.Equal(t, "warning: linters.settings.gocritic is not imported: tsk has no gocritic analyzer\n", warnings.String())

	// The file now has settings of its own, which only --force replaces.
	err = golangci.Import(log, &warnings, golangci.Config{}, dir, path, analyzers())
	assert.EqualError(t, err, path+" has settings besides imports and replace; pass --force to replace it")
	assert.NoError(t, golangci.Import(log, &warnings, golangci.Config{Force: true}, dir, path, analyzers()))
}
