package golangci_test

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
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
	var vet []docs.Analyzer
	for _, name := range vetNames() {
		analyzer := docs.Analyzer{Name: name, Group: "govet", EnabledByDefault: !slices.Contains(nonDefaultVet(), name)}
		switch name {
		case "printf":
			analyzer.Config = Some(docs.Config{
				Shape:    ts.ObjectShape{Properties: []ts.Property{{Name: "funcs", Shape: strings}}},
				Defaults: map[string]any{"funcs": []any{}},
			})
		case "shadow":
			analyzer.Config = Some(docs.Config{
				Shape:    ts.ObjectShape{Properties: []ts.Property{{Name: "strict", Shape: ts.BooleanShape{}}}},
				Defaults: map[string]any{"strict": false},
			})
		}
		vet = append(vet, analyzer)
	}
	return append(vet, []docs.Analyzer{
		{Name: "errcheck", EnabledByDefault: true, Config: Some(docs.Config{
			Shape:    ts.ObjectShape{Properties: []ts.Property{{Name: "checkBlank", Shape: ts.BooleanShape{}}}},
			Defaults: map[string]any{"checkBlank": false},
		})},
		{Name: "funlen", EnabledByDefault: true, Config: Some(docs.Config{
			Shape:    ts.ObjectShape{Properties: []ts.Property{{Name: "lines", Shape: ts.NumberShape{}}, {Name: "statements", Shape: ts.NumberShape{}}}},
			Defaults: map[string]any{"lines": 60.0, "statements": 40.0},
		})},
		// Revive's rules, of which dot-imports, exported, and var-naming run by
		// default. Revive's atomic clashes with vet's, so its name is prefixed.
		{Name: "dot_imports", Group: "revive", EnabledByDefault: true, Config: Some(docs.Config{
			Shape:    ts.ObjectShape{Properties: []ts.Property{{Name: "allowedPackages", Shape: strings}}},
			Defaults: map[string]any{"allowedPackages": []any{}},
		})},
		{Name: "exported", Group: "revive", EnabledByDefault: true},
		{Name: "var_naming", Group: "revive", EnabledByDefault: true},
		{Name: "line_length_limit", Group: "revive", Config: Some(docs.Config{
			Shape:    ts.ObjectShape{Properties: []ts.Property{{Name: "max", Shape: ts.NumberShape{}}}},
			Defaults: map[string]any{"max": 80.0},
		})},
		{Name: "revive_atomic", Group: "revive"},
		{Name: "imports_blocklist", Group: "revive"},
		{Name: "exhaustruct", EnabledByDefault: true, Config: Some(docs.Config{
			Shape:    ts.ObjectShape{Properties: []ts.Property{{Name: "ignorePatterns", Shape: strings}, {Name: "allowEmptyReturns", Shape: ts.BooleanShape{}}}},
			Defaults: map[string]any{"ignorePatterns": []any{}, "allowEmptyReturns": false},
		})},
		// Not a golangci-lint linter, so it keeps its default.
		{Name: "encapsulation", EnabledByDefault: true},
		{Name: "unused", EnabledByDefault: true},
	}...)
}

// vetNames returns the vet analyzers tsk has: all govet runs except findcall.
func vetNames() []string {
	return []string{
		"appends", "asmdecl", "assign", "atomic", "atomicalign", "bools", "buildtag", "cgocall", "composites",
		"copylocks", "deepequalerrors", "defers", "directive", "errorsas", "fieldalignment", "framepointer",
		"hostport", "httpmux", "httpresponse", "ifaceassert", "inline", "loopclosure", "lostcancel", "nilfunc",
		"nilness", "printf", "reflectvaluecompare", "shadow", "shift", "sigchanyzer", "slog", "sortslice",
		"stdmethods", "stdversion", "stringintconv", "structtag", "testinggoroutine", "tests", "timeformat",
		"unmarshal", "unreachable", "unsafeptr", "unusedresult", "unusedwrite", "waitgroup",
	}
}

// nonDefaultVet returns the vet analyzers tsk has that govet does not run by
// default.
func nonDefaultVet() []string {
	return []string{
		"atomicalign", "deepequalerrors", "fieldalignment", "httpmux", "nilness", "reflectvaluecompare", "shadow",
		"sortslice", "unusedwrite",
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
				// govet becomes its default analyzers.
				Settings: map[string]any{"disable-all": true, "enable": []string{
					"appends", "asmdecl", "assign", "atomic", "bools", "buildtag", "cgocall", "composites", "copylocks",
					"defers", "directive", "encapsulation", "errorsas", "framepointer", "funlen", "hostport", "httpresponse",
					"ifaceassert", "inline", "loopclosure", "lostcancel", "nilfunc", "printf", "shift", "sigchanyzer", "slog",
					"stdmethods", "stdversion", "stringintconv", "structtag", "testinggoroutine", "tests", "timeformat",
					"unmarshal", "unreachable", "unsafeptr", "unused", "unusedresult", "waitgroup",
				}},
				Tables:   map[string]map[string]any{},
				Warnings: []string{"not available in tsk, so not enabled: gocritic, ineffassign, staticcheck"},
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
				// govet's and revive's defaults match their analyzers' own.
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
				// Rules become their analyzers: line-length-limit is off by
				// default, and exported is on.
				Settings: map[string]any{"disable": []string{"exported"}, "enable": []string{"line_length_limit"}},
				Tables:   map[string]map[string]any{"dot_imports": {"allowed-packages": []any{"example.com/opt"}}},
				Warnings: []string{
					"linters.settings.revive.directives is not imported: tsk has no equivalent",
					"revive rule line-length-limit: positional arguments are not imported; set [line_length_limit] options instead",
					"linters.settings.revive.severity is not imported: tsk has no equivalent",
				},
			},
		},
		{
			// Rules, without enable-default-rules, replace revive's defaults.
			name: "ReviveSelectsRules",
			config: `
version: "2"
linters:
  default: none
  enable: [revive]
  settings:
    revive:
      rules:
        - name: var-naming
        - name: atomic
        - name: imports-blacklist
        - name: unknown-rule
  exclusions:
    rules:
      - text: "^var-naming: don't use"
        linters: [revive]
      - path: legacy/
        linters: [revive]
        text: "should have"
`,
			expected: golangci.Result{
				Settings: map[string]any{
					"disable-all": true,
					"enable":      []string{"encapsulation", "imports_blocklist", "revive_atomic", "var_naming"},
					"exclude": []any{
						map[string]any{"linters": []string{"var_naming"}, "text": "^don't use"},
						map[string]any{"linters": []string{"revive"}, "path": "legacy/", "text": "should have"},
					},
				},
				Tables: map[string]map[string]any{},
				Warnings: []string{
					"revive rule unknown-rule is not imported: tsk has no analyzer for it",
					`linters.exclusions.rules[1] {"linters":["revive"],"path":"legacy/","text":"should have"}: findings of revive's analyzers do not start with their names in tsk; check its text still matches`,
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
			// govet's analyzers are separate in tsk, so its settings spread
			// across their tables, and exclusion rules name them or their group.
			name: "Govet",
			config: `
version: "2"
linters:
  default: none
  enable: [govet]
  settings:
    govet:
      disable-all: true
      enable: [printf, shadow, findcall]
      check-shadowing: true
      settings:
        printf:
          funcs: [example.com/log.Infof]
        shadow:
          strict: "yes"
        findcall:
          name: x
  exclusions:
    rules:
      - text: '^shadow: declaration of "err"'
        linters: [govet]
      - text: "^printf:"
        path: cmd/
        linters: [govet]
      - text: "composite literal"
        path: cmd/
        linters: [govet]
`,
			expected: golangci.Result{
				Settings: map[string]any{
					"disable-all": true,
					"enable":      []string{"encapsulation", "printf", "shadow"},
					"exclude": []any{
						map[string]any{"linters": []string{"shadow"}, "text": `^declaration of "err"`},
						map[string]any{"linters": []string{"printf"}, "path": "cmd/"},
						map[string]any{"linters": []string{"govet"}, "path": "cmd/", "text": "composite literal"},
					},
				},
				Tables: map[string]map[string]any{"printf": {"funcs": []any{"example.com/log.Infof"}}},
				Warnings: []string{
					"not available in tsk, so not enabled: findcall",
					"linters.settings.govet.check-shadowing is not imported: tsk has no equivalent",
					"linters.settings.govet.settings.findcall is not imported: tsk has no findcall analyzer",
					"linters.settings.govet.settings.shadow.strict is not imported: shadow.strict: expected a boolean, got a string",
					`linters.exclusions.rules[2] {"linters":["govet"],"path":"cmd/","text":"composite literal"}: findings of govet's analyzers do not start with their names in tsk; check its text still matches`,
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
	assert.EqualError(t, err, strconv.Quote(path)+" has settings besides imports and replace; pass --force to replace it")
	assert.NoError(t, golangci.Import(log, &warnings, golangci.Config{Force: true}, dir, path, analyzers()))
}
