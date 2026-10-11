// Package golangci converts a golangci-lint v2 config into a tsk config file.
package golangci

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/alecthomas/errors"
	ts "github.com/microsoft/TypeScript/tsc/shim/typescript"
	"github.com/pelletier/go-toml/v2"
	"go.yaml.in/yaml/v3"

	"github.com/alecthomas/tsk/internal/config"
	"github.com/alecthomas/tsk/internal/docs"
)

// Config holds the options for importing a golangci-lint config.
type Config struct {
	File  string `arg:"" optional:"" type:"path" help:"golangci-lint config to import. Defaults to .golangci.yml, .golangci.yaml, .golangci.toml, or .golangci.json in the working directory."`
	Force bool   `help:"Replace a config file that has settings besides imports and replace."`
}

// Import converts the golangci-lint config c names, or the one in dir, and
// writes it to the tsk config file at path, keeping that file's imports and
// replace. Settings tsk cannot express are written to warnings, one per line.
func Import(log *slog.Logger, warnings io.Writer, c Config, dir, path string, analyzers []docs.Analyzer) error {
	source := c.File
	if source == "" {
		found, err := find(dir)
		if err != nil {
			return err
		}
		source = found
	}
	existing, err := config.Load(path)
	if err != nil {
		return errors.WithStack(err)
	}
	if !c.Force && !onlyImports(existing) {
		return errors.Errorf("%s has settings besides imports and replace; pass --force to replace it", path)
	}
	golangci, err := read(source)
	if err != nil {
		return err
	}
	result, err := Convert(golangci, analyzers)
	if err != nil {
		return errors.Wrapf(err, "%s", source)
	}
	text, err := render(existing, result, filepath.Base(source))
	if err != nil {
		return err
	}
	// The output must load, so a conversion bug never leaves a broken file.
	if _, err := config.Parse(path, string(text)); err != nil {
		return errors.Wrap(err, "converted config does not load")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return errors.Wrap(err, "create config directory")
	}
	if err := os.WriteFile(path, text, 0o600); err != nil {
		return errors.Wrap(err, "write config")
	}
	for _, warning := range result.Warnings {
		fmt.Fprintln(warnings, "warning: "+warning) //nolint:errcheck // Warnings are best effort.
	}
	log.Info("Imported golangci-lint config", "from", source, "to", path)
	return nil
}

func find(dir string) (string, error) {
	for _, name := range configNames() {
		path := filepath.Join(dir, name)
		if _, err := os.Stat(path); err == nil {
			return path, nil
		}
	}
	return "", errors.Errorf("no golangci-lint config in %s; name one, such as tsk config import .golangci.yml", dir)
}

// onlyImports reports whether a config file sets nothing but imports and
// replace, so replacing it loses nothing.
func onlyImports(file config.File) bool {
	return len(file.Tables) == 0 && len(file.Disable) == 0 && !file.DisableAll && len(file.Enable) == 0 &&
		!file.LintGenerated && !file.NoTests && len(file.SkipTests) == 0 && len(file.Exclude) == 0 && len(file.ExcludePaths) == 0
}

// read decodes a golangci-lint config by its extension, with values typed as
// the TOML decoder types them.
func read(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.Wrap(err, "read golangci-lint config")
	}
	var decoded any
	switch filepath.Ext(path) {
	case ".toml":
		err = toml.Unmarshal(data, &decoded)
	case ".json":
		err = json.Unmarshal(data, &decoded)
	default:
		err = yaml.Unmarshal(data, &decoded)
	}
	if err != nil {
		return nil, errors.Wrapf(err, "parse %s", path)
	}
	root, ok := normalise(decoded).(map[string]any)
	if !ok {
		return nil, errors.Errorf("%s: expected a mapping at the top level", path)
	}
	return root, nil
}

// normalise converts integers to int64 and whole JSON numbers to int64, as
// config.Resolve expects from TOML.
func normalise(value any) any {
	switch value := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(value))
		for key, element := range value {
			if element != nil {
				out[key] = normalise(element)
			}
		}
		return out
	case []any:
		out := make([]any, 0, len(value))
		for _, element := range value {
			out = append(out, normalise(element))
		}
		return out
	case int:
		return int64(value)
	case uint64:
		return int64(value) //nolint:gosec // Config numbers are small.
	}
	return value
}

// Result is a converted config: top-level settings and analyzer tables by
// TOML key, and what could not be converted.
type Result struct {
	Settings map[string]any
	Tables   map[string]map[string]any
	Warnings []string
}

// Convert turns a decoded golangci-lint v2 config into tsk settings and
// tables for the given analyzers. Each table is checked against its
// analyzer's config type; keys that do not fit are dropped with a warning.
func Convert(golangci map[string]any, analyzers []docs.Analyzer) (Result, error) {
	if version := fmt.Sprint(golangci["version"]); version != "2" {
		return Result{}, errors.Errorf("only golangci-lint v2 configs can be imported; convert this one with golangci-lint migrate")
	}
	return newConverter(analyzers).convert(golangci)
}

// converter accumulates a conversion's result.
type converter struct {
	analyzers map[string]docs.Analyzer
	result    Result
}

func newConverter(analyzers []docs.Analyzer) *converter {
	byName := map[string]docs.Analyzer{}
	for _, analyzer := range analyzers {
		byName[analyzer.Name] = analyzer
	}
	return &converter{analyzers: byName, result: Result{Settings: map[string]any{}, Tables: map[string]map[string]any{}}}
}

func (c *converter) convert(golangci map[string]any) (Result, error) {
	for _, key := range slices.Sorted(maps.Keys(golangci)) {
		switch key {
		case "version":
		case "run":
			c.run(table(golangci, key))
		case "linters":
			if err := c.linters(table(golangci, key)); err != nil {
				return Result{}, err
			}
		case "formatters":
			c.warnf("formatters are not imported: tsk does not format code")
		default:
			c.warnf("%s is not imported: tsk has no equivalent", key)
		}
	}
	return c.result, nil
}

func (c *converter) warnf(format string, args ...any) {
	c.result.Warnings = append(c.result.Warnings, fmt.Sprintf(format, args...))
}

func (c *converter) run(run map[string]any) {
	for _, key := range slices.Sorted(maps.Keys(run)) {
		if key == "tests" {
			if tests, ok := run[key].(bool); ok && !tests {
				c.result.Settings["no-tests"] = true
			}
			continue
		}
		c.warnf("run.%s is not imported: tsk has no equivalent", key)
	}
}

func (c *converter) linters(linters map[string]any) error {
	if err := c.selection(linters); err != nil {
		return err
	}
	settings := table(linters, "settings")
	for _, name := range slices.Sorted(maps.Keys(settings)) {
		if name == govet {
			c.govetSettings(table(settings, name))
			continue
		}
		c.settings("linters.settings."+name, name, table(settings, name))
	}
	c.exclusions(table(linters, "exclusions"))
	for _, key := range slices.Sorted(maps.Keys(linters)) {
		if !slices.Contains([]string{"default", "enable", "disable", "settings", "exclusions"}, key) {
			c.warnf("linters.%s is not imported: tsk has no equivalent", key)
		}
	}
	return nil
}

// selection converts which linters run. golangci-lint's default set, other
// than all, becomes an explicit enable list; analyzers golangci-lint does not
// know stay enabled. govet becomes the vet analyzers its settings select.
func (c *converter) selection(section map[string]any) error {
	enable := analyzerNames(list(section, "enable"))
	disable := analyzerNames(list(section, "disable"))
	vet := vetSelection(table(table(section, "settings"), govet))
	mode, _ := section["default"].(string)
	var base []string
	switch mode {
	case "all":
		if slices.Contains(disable, govet) {
			disable = append(disable, vetAnalyzers()...)
		} else {
			disable = append(disable, slices.DeleteFunc(vetAnalyzers(), func(name string) bool { return slices.Contains(vet, name) })...)
		}
		if names := c.known(disable); len(names) > 0 {
			c.result.Settings["disable"] = names
		}
		return nil
	case "", "standard":
		base = standardLinters()
	case "none":
	case "fast":
		c.warnf("linters.default: fast is imported as none: tsk does not know which analyzers are fast")
	default:
		return errors.Errorf("linters.default: unknown value %q", mode)
	}
	selected := slices.DeleteFunc(slices.Concat(base, enable), func(name string) bool { return slices.Contains(disable, name) })
	if slices.Contains(selected, govet) {
		selected = slices.Concat(slices.DeleteFunc(selected, func(name string) bool { return name == govet }), vet)
	}
	if missing := slices.DeleteFunc(slices.Clone(selected), c.isKnown); len(missing) > 0 {
		slices.Sort(missing)
		c.warnf("not available in tsk, so not enabled: %s", strings.Join(slices.Compact(missing), ", "))
	}
	known := slices.Concat(golangciLinters(), vetAnalyzers())
	var run []string
	for _, name := range slices.Sorted(maps.Keys(c.analyzers)) {
		if !slices.Contains(known, name) || slices.Contains(selected, name) {
			run = append(run, name)
		}
	}
	c.result.Settings["disable-all"] = true
	c.result.Settings["enable"] = run
	return nil
}

// The govet settings choosing which vet analyzers run.
const (
	vetEnable     = "enable"
	vetDisable    = "disable"
	vetEnableAll  = "enable-all"
	vetDisableAll = "disable-all"
)

// vetSelection returns the vet analyzers golangci-lint's govet runs with the
// given settings.
func vetSelection(settings map[string]any) []string {
	enable, disable := list(settings, vetEnable), list(settings, vetDisable)
	enableAll, _ := settings[vetEnableAll].(bool)
	disableAll, _ := settings[vetDisableAll].(bool)
	var selected []string
	for _, name := range vetAnalyzers() {
		var on bool
		switch {
		case enableAll:
			on = !slices.Contains(disable, name)
		case slices.Contains(enable, name):
			on = true
		case slices.Contains(disable, name), disableAll:
			on = false
		default:
			on = !slices.Contains(offVetAnalyzers(), name)
		}
		if on {
			selected = append(selected, name)
		}
	}
	return selected
}

func (c *converter) isKnown(name string) bool {
	_, ok := c.analyzers[name]
	return ok
}

// known returns the names tsk has an analyzer for, sorted.
func (c *converter) known(names []string) []string {
	known := slices.DeleteFunc(slices.Clone(names), func(name string) bool { return !c.isKnown(name) })
	slices.Sort(known)
	return slices.Compact(known)
}

// govetSettings converts each vet analyzer's settings into its own table. The
// enable and disable settings are applied by selection.
func (c *converter) govetSettings(settings map[string]any) {
	for _, key := range slices.Sorted(maps.Keys(settings)) {
		switch key {
		case vetEnable, vetDisable, vetEnableAll, vetDisableAll:
		case "settings":
			analyzers := table(settings, key)
			for _, name := range slices.Sorted(maps.Keys(analyzers)) {
				c.settings("linters.settings.govet.settings."+name, name, table(analyzers, name))
			}
		default:
			c.warnf("linters.settings.govet.%s is not imported: tsk has no equivalent", key)
		}
	}
}

// settings converts one linter's settings, found at path, into its
// analyzer's table.
func (c *converter) settings(path, linter string, settings map[string]any) {
	name := analyzerName(linter)
	analyzer, ok := c.analyzers[name]
	if !ok {
		c.warnf("%s is not imported: tsk has no %s analyzer", path, linter)
		return
	}
	if name == "revive" {
		settings = c.revive(settings)
	}
	// Without a config type, the nil shape rejects every key.
	var shape ts.Shape
	var defaults any
	if described, ok := analyzer.Config.Get(); ok {
		shape, defaults = described.Shape, described.Defaults
	}
	// Linters sharing an analyzer merge into one table, later ones winning.
	kept := c.result.Tables[name]
	if kept == nil {
		kept = map[string]any{}
	}
	for _, key := range slices.Sorted(maps.Keys(settings)) {
		if replacement, isV4 := exhaustructV4Options()[key]; linter == exhaustruct && isV4 {
			c.warnf("linters.settings.exhaustruct.%s is not imported: it is an exhaustruct v4 option, and tsk's exhaustruct is v5, which has %s instead", key, replacement)
			continue
		}
		// Each key is checked alone, so one that does not fit drops only itself.
		if _, err := config.Resolve(name, shape, defaults, map[string]any{key: settings[key]}); err != nil {
			c.warnf("%s.%s is not imported: %s", path, key, err)
			continue
		}
		kept[key] = settings[key]
	}
	if len(kept) > 0 {
		c.result.Tables[name] = kept
	}
}

// revive converts revive's settings, whose rules list becomes enable and
// disable lists and a table of options per rule.
func (c *converter) revive(settings map[string]any) map[string]any {
	out := map[string]any{}
	var enable, disable []string
	for _, key := range slices.Sorted(maps.Keys(settings)) {
		switch key {
		case "rules":
			for _, item := range array(settings, key) {
				rule, ok := item.(map[string]any)
				name, named := rule["name"].(string)
				if !ok || !named {
					c.warnf("linters.settings.revive.rules: a rule without a name is not imported")
					continue
				}
				if disabled, _ := rule["disabled"].(bool); disabled {
					disable = append(disable, name)
				} else {
					enable = append(enable, name)
				}
				c.reviveRule(name, rule, out)
			}
		case "directives":
			var names []any
			for _, item := range array(settings, key) {
				if directive, ok := item.(map[string]any); ok {
					names = append(names, directive["name"])
				}
			}
			out[key] = names
		case "severity", "max-open-files":
			c.warnf("linters.settings.revive.%s is not imported: tsk has no equivalent", key)
		default:
			out[key] = settings[key]
		}
	}
	if len(enable) > 0 {
		out["enable"] = anys(enable)
	}
	if len(disable) > 0 {
		out["disable"] = anys(disable)
	}
	return out
}

// reviveRule converts a rule's arguments into its options table. Only an
// arguments list holding one map of options can be converted: positional
// arguments have no names to map.
func (c *converter) reviveRule(name string, rule map[string]any, out map[string]any) {
	for _, key := range slices.Sorted(maps.Keys(rule)) {
		switch key {
		case "name", "disabled":
		case "arguments":
			arguments, _ := rule[key].([]any)
			if options, ok := single(arguments); ok {
				out[name] = options
				continue
			}
			if len(arguments) > 0 {
				c.warnf("revive rule %s: positional arguments are not imported; set [revive.%s] options instead", name, name)
			}
		default:
			c.warnf("revive rule %s: %s is not imported: tsk has no equivalent", name, key)
		}
	}
}

func single(arguments []any) (map[string]any, bool) {
	if len(arguments) != 1 {
		return nil, false
	}
	options, ok := arguments[0].(map[string]any)
	return options, ok
}

// testFile matches a path pattern that only test files match.
func testFile(pattern string) bool {
	re, err := regexp.Compile(pattern)
	return err == nil && re.MatchString("dir/file_test.go") && !re.MatchString("dir/file.go")
}

// exclusions converts golangci-lint's exclusions. Rules excluding linters
// from test files become skip-tests; other rules and paths keep their form.
func (c *converter) exclusions(exclusions map[string]any) {
	var skipTests []string
	var rules []any
	for _, key := range slices.Sorted(maps.Keys(exclusions)) {
		switch key {
		case "generated":
			if exclusions[key] == "disable" {
				c.result.Settings["lint-generated"] = true
			}
		case "rules":
			for i, item := range array(exclusions, key) {
				rule, _ := item.(map[string]any)
				rule = c.vetRule(i, rule)
				path, _ := rule["path"].(string)
				names := analyzerNames(list(rule, "linters"))
				if len(rule) == 2 && testFile(path) && len(names) > 0 {
					skipTests = append(skipTests, c.known(names)...)
					continue
				}
				if converted, ok := c.exclusionRule(i, rule); ok {
					rules = append(rules, converted)
				}
			}
		case "paths":
			if paths := list(exclusions, key); len(paths) > 0 {
				c.result.Settings["exclude-paths"] = paths
			}
		case "presets":
			c.warnf("linters.exclusions.presets are not imported: tsk has no presets; add exclude rules for the findings they dropped")
		default:
			c.warnf("linters.exclusions.%s is not imported: tsk has no equivalent", key)
		}
	}
	if len(skipTests) > 0 {
		slices.Sort(skipTests)
		c.result.Settings["skip-tests"] = slices.Compact(skipTests)
	}
	if len(rules) > 0 {
		c.result.Settings["exclude"] = rules
	}
}

// vetRule rewrites an exclusion rule naming govet to name the vet analyzers.
// govet's findings start with their analyzer's name, as in "printf: ...", and
// tsk's do not, so a text pattern starting with a name narrows the rule to it.
func (c *converter) vetRule(i int, rule map[string]any) map[string]any {
	linters := list(rule, "linters")
	if !slices.Contains(analyzerNames(linters), govet) {
		return rule
	}
	out := maps.Clone(rule)
	others := slices.DeleteFunc(slices.Clone(linters), func(name string) bool { return analyzerName(name) == govet })
	text, _ := rule["text"].(string)
	prefixed := regexp.MustCompile(`^(\^?)(\w+): ?(.*)$`).FindStringSubmatch(text)
	if prefixed != nil && len(others) == 0 && slices.Contains(vetAnalyzers(), prefixed[2]) {
		out["linters"] = []any{prefixed[2]}
		if rest := prefixed[1] + prefixed[3]; rest != "" && rest != "^" {
			out["text"] = rest
		} else {
			delete(out, "text")
		}
		return out
	}
	if text != "" {
		c.warnf("linters.exclusions.rules[%d] %s: its text now applies to every vet analyzer, whose findings do not start with the analyzer's name in tsk", i, describe(rule))
	}
	out["linters"] = anys(slices.Concat(others, vetAnalyzers()))
	return out
}

// exclusionRule converts one exclusion rule, keeping only the linters tsk
// has. A rule only for linters tsk lacks drops nothing, so it is left out.
func (c *converter) exclusionRule(i int, rule map[string]any) (map[string]any, bool) {
	converted := map[string]any{}
	for _, key := range slices.Sorted(maps.Keys(rule)) {
		switch key {
		case "linters":
			linters := list(rule, key)
			names := c.known(analyzerNames(linters))
			if len(linters) > 0 && len(names) == 0 {
				return nil, false
			}
			converted[key] = names
		case "path", "path-except", "text", "source":
			converted[key] = rule[key]
		default:
			c.warnf("linters.exclusions.rules[%d] %s is not imported: tsk exclusions have no %s", i, describe(rule), key)
			return nil, false
		}
	}
	if len(converted) == 1 && converted["linters"] != nil {
		c.warnf("linters.exclusions.rules[%d] %s is not imported: it names only linters; disable them instead", i, describe(rule))
		return nil, false
	}
	return converted, true
}

// describe shows a decoded value as JSON, so a warning can quote it.
func describe(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	return string(encoded)
}

func table(m map[string]any, key string) map[string]any {
	value, _ := m[key].(map[string]any)
	return value
}

func array(m map[string]any, key string) []any {
	value, _ := m[key].([]any)
	return value
}

// list returns the strings in an array, skipping anything else.
func list(m map[string]any, key string) []string {
	var out []string
	for _, item := range array(m, key) {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func anys(names []string) []any {
	out := make([]any, 0, len(names))
	for _, name := range names {
		out = append(out, name)
	}
	return out
}

// render writes the converted config as TOML: existing's imports, the
// settings, existing's replace, then each analyzer's table. Every table comes
// after the plain settings, which would otherwise fall inside it.
func render(existing config.File, result Result, source string) ([]byte, error) {
	var out bytes.Buffer
	fmt.Fprintf(&out, "# Imported from %s by tsk config import.\n\n", source)
	sections := []map[string]any{}
	if len(existing.Imports) > 0 {
		imports := make([]string, 0, len(existing.Imports))
		for _, imported := range existing.Imports {
			imports = append(imports, imported.String())
		}
		sections = append(sections, map[string]any{"imports": imports})
	}
	sections = append(sections, result.Settings)
	if len(existing.Replace) > 0 {
		sections = append(sections, map[string]any{"replace": existing.Replace})
	}
	for _, name := range slices.Sorted(maps.Keys(result.Tables)) {
		sections = append(sections, map[string]any{name: result.Tables[name]})
	}
	for _, section := range sections {
		if len(section) == 0 {
			continue
		}
		if out.Len() > 0 && !bytes.HasSuffix(out.Bytes(), []byte("\n\n")) {
			out.WriteString("\n")
		}
		if err := toml.NewEncoder(&out).SetIndentTables(false).Encode(section); err != nil {
			return nil, errors.Wrap(err, "encode config")
		}
	}
	return out.Bytes(), nil
}
