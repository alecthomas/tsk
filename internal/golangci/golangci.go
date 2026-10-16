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
		found, ok := Find(dir)
		if !ok {
			return errors.Errorf("no golangci-lint config in %q; name one, such as tsk config import .golangci.yml", dir)
		}
		source = found
	}
	existing, err := config.Load(path)
	if err != nil {
		return errors.WithStack(err)
	}
	if !c.Force && !onlyImports(existing) {
		return errors.Errorf("%q has settings besides imports and replace; pass --force to replace it", path)
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

// Find returns the path of the golangci-lint config in dir, trying each name
// golangci-lint accepts in turn.
func Find(dir string) (path string, found bool) {
	for _, name := range configNames() {
		path := filepath.Join(dir, name)
		if _, err := os.Stat(path); err == nil {
			return path, true
		}
	}
	return "", false
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
		return nil, errors.Wrapf(err, "parse %q", path)
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
		switch name {
		case govet:
			c.govetSettings(table(settings, name))
		case revive:
			c.reviveSettings(table(settings, name))
		default:
			c.settings("linters.settings."+name, name, table(settings, name))
		}
	}
	c.exclusions(table(linters, "exclusions"))
	for _, key := range slices.Sorted(maps.Keys(linters)) {
		if !slices.Contains([]string{"default", "enable", "disable", "settings", "exclusions"}, key) {
			c.warnf("linters.%s is not imported: tsk has no equivalent", key)
		}
	}
	return nil
}

// selection converts which linters run. govet and revive become the members
// of their tsk groups that their settings select. golangci-lint's default set,
// other than all, becomes an explicit enable list; analyzers golangci-lint
// does not know keep their defaults.
func (c *converter) selection(section map[string]any) error {
	enable := analyzerNames(list(section, "enable"))
	disable := analyzerNames(list(section, "disable"))
	settings := table(section, "settings")
	members := map[string][]string{
		govet:  vetSelection(table(settings, govet)),
		revive: c.reviveSelection(table(settings, revive)),
	}
	mode, _ := section["default"].(string)
	var base []string
	switch mode {
	case "all":
		c.selectAll(disable, members)
		return nil
	case "", "standard":
		base = standardLinters()
	case "none":
	case "fast":
		c.warnf("linters.default: fast is imported as none: tsk does not know which analyzers are fast")
	default:
		return errors.Errorf("linters.default: unknown value %q", mode)
	}
	var selected []string
	for _, name := range slices.Concat(base, enable) {
		switch {
		case slices.Contains(disable, name):
		case members[name] != nil:
			selected = append(selected, members[name]...)
		default:
			selected = append(selected, name)
		}
	}
	if missing := slices.DeleteFunc(slices.Clone(selected), c.isKnown); len(missing) > 0 {
		slices.Sort(missing)
		c.warnf("not available in tsk, so not enabled: %s", strings.Join(slices.Compact(missing), ", "))
	}
	var run []string
	for _, name := range slices.Sorted(maps.Keys(c.analyzers)) {
		if slices.Contains(selected, name) || (!c.controlled(name) && c.analyzers[name].EnabledByDefault) {
			run = append(run, name)
		}
	}
	c.result.Settings["disable-all"] = true
	c.result.Settings["enable"] = run
	return nil
}

// selectAll converts default: all, under which every linter runs but those
// disabled, and govet and revive run the members their settings select.
func (c *converter) selectAll(disable []string, members map[string][]string) {
	var enable []string
	for group, selected := range members {
		if slices.Contains(disable, group) {
			continue
		}
		for _, name := range c.members(group) {
			switch {
			case !slices.Contains(selected, name) && c.analyzers[name].EnabledByDefault:
				disable = append(disable, name)
			case slices.Contains(selected, name) && !c.analyzers[name].EnabledByDefault:
				enable = append(enable, name)
			}
		}
	}
	if names := c.known(disable); len(names) > 0 {
		c.result.Settings["disable"] = names
	}
	if len(enable) > 0 {
		slices.Sort(enable)
		c.result.Settings["enable"] = enable
	}
}

// controlled reports whether a golangci-lint config decides if the analyzer
// runs: it ports a golangci-lint linter, or belongs to govet's or revive's group.
func (c *converter) controlled(name string) bool {
	return slices.Contains(golangciLinters(), name) || slices.Contains(golangciLinters(), c.analyzers[name].Group)
}

// members returns the analyzers in a group, sorted.
func (c *converter) members(group string) []string {
	var names []string
	for _, name := range slices.Sorted(maps.Keys(c.analyzers)) {
		if c.analyzers[name].Group == group {
			names = append(names, name)
		}
	}
	return names
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

// isKnown reports whether tsk has an analyzer or group of the name.
func (c *converter) isKnown(name string) bool {
	_, ok := c.analyzers[name]
	return ok || len(c.members(name)) > 0
}

// The revive settings choosing which rules run.
const (
	reviveEnableAll     = "enable-all-rules"
	reviveEnableDefault = "enable-default-rules"
)

// reviveSelection returns the analyzers for the revive rules that revive runs
// with the given settings, except that disabling a rule does not, alone, turn
// the default rules off.
func (c *converter) reviveSelection(settings map[string]any) []string {
	var enable, disable []string
	for _, item := range array(settings, "rules") {
		rule, _ := item.(map[string]any)
		name, _ := rule["name"].(string)
		analyzer, ok := c.reviveAnalyzer(name)
		if !ok {
			continue
		}
		if disabled, _ := rule["disabled"].(bool); disabled {
			disable = append(disable, analyzer)
		} else {
			enable = append(enable, analyzer)
		}
	}
	enableAll, _ := settings[reviveEnableAll].(bool)
	enableDefault, _ := settings[reviveEnableDefault].(bool)
	var selected []string
	for _, name := range c.members(revive) {
		switch {
		case slices.Contains(disable, name):
		case enableAll, slices.Contains(enable, name),
			(enableDefault || len(enable) == 0) && c.analyzers[name].EnabledByDefault:
			selected = append(selected, name)
		}
	}
	return selected
}

// reviveAnalyzer returns tsk's analyzer for a revive rule: its name in
// snake_case, prefixed with revive_ where that would clash with another.
// Revive still accepts imports-blacklist, the rule's old name.
func (c *converter) reviveAnalyzer(rule string) (string, bool) {
	if rule == "imports-blacklist" {
		rule = "imports-blocklist"
	}
	name := strings.ReplaceAll(rule, "-", "_")
	for _, candidate := range []string{name, "revive_" + name} {
		if c.analyzers[candidate].Group == revive {
			return candidate, true
		}
	}
	return "", false
}

// known returns the names tsk has an analyzer or group for, sorted.
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

// reviveSettings converts each revive rule's arguments into its analyzer's
// table. Which rules run is applied by selection.
func (c *converter) reviveSettings(settings map[string]any) {
	for _, key := range slices.Sorted(maps.Keys(settings)) {
		switch key {
		case reviveEnableAll, reviveEnableDefault:
		case "rules":
			for _, item := range array(settings, key) {
				rule, _ := item.(map[string]any)
				name, named := rule["name"].(string)
				if !named {
					c.warnf("linters.settings.revive.rules: a rule without a name is not imported")
					continue
				}
				c.reviveRule(name, rule)
			}
		default:
			c.warnf("linters.settings.revive.%s is not imported: tsk has no equivalent", key)
		}
	}
}

// reviveRule converts a rule's arguments into its analyzer's table. Only an
// arguments list holding one map of options can be converted: positional
// arguments have no names to map.
func (c *converter) reviveRule(name string, rule map[string]any) {
	analyzer, ok := c.reviveAnalyzer(name)
	if !ok {
		c.warnf("revive rule %s is not imported: tsk has no analyzer for it", name)
		return
	}
	for _, key := range slices.Sorted(maps.Keys(rule)) {
		switch key {
		case "name", "disabled":
		case "arguments":
			arguments, _ := rule[key].([]any)
			if options, ok := single(arguments); ok {
				c.settings("linters.settings.revive.rules."+name+".arguments", analyzer, options)
				continue
			}
			if len(arguments) > 0 {
				c.warnf("revive rule %s: positional arguments are not imported; set [%s] options instead", name, analyzer)
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
				rule = c.groupRule(i, rule)
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

// groupRule narrows an exclusion rule naming only govet or revive. Their
// findings start with the analyzer or rule name, as in "printf: ...", where
// tsk's do not, so a text pattern starting with one names that analyzer.
// Otherwise the rule keeps the name, which is also the group's in tsk.
func (c *converter) groupRule(i int, rule map[string]any) map[string]any {
	linters := analyzerNames(list(rule, "linters"))
	if len(linters) != 1 || (linters[0] != govet && linters[0] != revive) {
		return rule
	}
	text, _ := rule["text"].(string)
	if prefixed := regexp.MustCompile(`^(\^?)([\w-]+): ?(.*)$`).FindStringSubmatch(text); prefixed != nil {
		analyzer, ok := prefixed[2], slices.Contains(vetAnalyzers(), prefixed[2])
		if linters[0] == revive {
			analyzer, ok = c.reviveAnalyzer(prefixed[2])
		}
		if ok {
			out := maps.Clone(rule)
			out["linters"] = []any{analyzer}
			if rest := prefixed[1] + prefixed[3]; rest != "" && rest != "^" {
				out["text"] = rest
			} else {
				delete(out, "text")
			}
			return out
		}
	}
	if text != "" {
		c.warnf("linters.exclusions.rules[%d] %s: findings of %s's analyzers do not start with their names in tsk; check its text still matches", i, describe(rule), linters[0])
	}
	return rule
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
