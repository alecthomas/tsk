package config

import (
	"regexp"
	"slices"

	"github.com/alecthomas/errors"
	. "github.com/alecthomas/types/optional"
)

// Exclusion drops findings for which every condition it sets matches. Its
// patterns are Go regular expressions.
type Exclusion struct {
	Linters []string `toml:"linters"`
	// Path and PathExcept match the finding's file path, relative to the
	// project root with "/" separators.
	Path       string `toml:"path"`
	PathExcept string `toml:"path-except"`
	Text       string `toml:"text"`
	// Source matches the line the finding starts on.
	Source string `toml:"source"`
}

// Finding is a diagnostic as exclusions see it.
type Finding struct {
	Analyzer string
	// Path is relative to the project root, with "/" separators.
	Path    string
	Message string
	// Source returns the line the finding starts on. It is called only when a
	// rule needs it, since it reads the file.
	Source func() string
}

// Excluder decides which findings the config's exclusions drop.
type Excluder struct {
	rules []rule
	paths []*regexp.Regexp
}

// rule is a compiled Exclusion.
type rule struct {
	linters    []string
	path       Option[*regexp.Regexp]
	pathExcept Option[*regexp.Regexp]
	text       Option[*regexp.Regexp]
	source     Option[*regexp.Regexp]
}

func newExcluder(rules []rule, paths []*regexp.Regexp) Excluder {
	return Excluder{rules: rules, paths: paths}
}

// Excluder compiles the config's exclusions.
func (f File) Excluder() (Excluder, error) {
	rules := make([]rule, 0, len(f.Exclude))
	for i, exclusion := range f.Exclude {
		compiled, err := compileRule(exclusion)
		if err != nil {
			return newExcluder(nil, nil), errors.Wrapf(err, "exclude[%d]", i)
		}
		rules = append(rules, compiled)
	}
	paths := make([]*regexp.Regexp, 0, len(f.ExcludePaths))
	for i, pattern := range f.ExcludePaths {
		re, err := regexp.Compile(pattern)
		if err != nil {
			return newExcluder(nil, nil), errors.Wrapf(err, "exclude-paths[%d]", i)
		}
		paths = append(paths, re)
	}
	return newExcluder(rules, paths), nil
}

func compileRule(exclusion Exclusion) (rule, error) {
	if exclusion.Path == "" && exclusion.PathExcept == "" && exclusion.Text == "" && exclusion.Source == "" {
		return rule{}, errors.New("set path, path-except, text, or source; to turn analyzers off everywhere, use disable")
	}
	compiled := rule{linters: exclusion.Linters}
	for _, field := range []struct {
		key     string
		pattern string
		target  *Option[*regexp.Regexp]
	}{
		{"path", exclusion.Path, &compiled.path},
		{"path-except", exclusion.PathExcept, &compiled.pathExcept},
		{"text", exclusion.Text, &compiled.text},
		{"source", exclusion.Source, &compiled.source},
	} {
		if field.pattern == "" {
			continue
		}
		re, err := regexp.Compile(field.pattern)
		if err != nil {
			return rule{}, errors.Wrap(err, field.key)
		}
		*field.target = Some(re)
	}
	return compiled, nil
}

// Empty reports whether the excluder drops nothing.
func (e Excluder) Empty() bool {
	return len(e.rules) == 0 && len(e.paths) == 0
}

// Excluded reports whether a finding is dropped.
func (e Excluder) Excluded(finding Finding) bool {
	if slices.ContainsFunc(e.paths, func(re *regexp.Regexp) bool { return re.MatchString(finding.Path) }) {
		return true
	}
	return slices.ContainsFunc(e.rules, func(r rule) bool { return r.matches(finding) })
}

func (r rule) matches(finding Finding) bool {
	if len(r.linters) > 0 && !slices.Contains(r.linters, finding.Analyzer) {
		return false
	}
	if !matchOrAbsent(r.path, finding.Path) || matches(r.pathExcept, finding.Path) || !matchOrAbsent(r.text, finding.Message) {
		return false
	}
	// The source line is read last, as it is the costliest condition.
	source, ok := r.source.Get()
	return !ok || source.MatchString(finding.Source())
}

// matches reports whether a pattern is present and matches text.
func matches(pattern Option[*regexp.Regexp], text string) bool {
	re, ok := pattern.Get()
	return ok && re.MatchString(text)
}

// matchOrAbsent reports whether a pattern is absent or matches text.
func matchOrAbsent(pattern Option[*regexp.Regexp], text string) bool {
	re, ok := pattern.Get()
	return !ok || re.MatchString(text)
}
