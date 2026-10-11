package config_test

import (
	"testing"

	"github.com/alecthomas/assert/v2"

	"github.com/alecthomas/tsk/internal/config"
)

func TestExcluded(t *testing.T) {
	file, err := config.Parse("config.toml", `
exclude-paths = ['^vendor/']

[[exclude]]
linters = ["revive"]
text = 'should have a package comment'

[[exclude]]
path = '^internal/'
path-except = '_test\.go$'
linters = ["godot", "lll"]

[[exclude]]
linters = ["lll"]
source = '^//go:generate '
`)
	assert.NoError(t, err)
	excluder, err := file.Excluder()
	assert.NoError(t, err)
	tests := []struct {
		name     string
		analyzer string
		path     string
		message  string
		source   string
		excluded bool
	}{
		{name: "ExcludedPath", analyzer: "godot", path: "vendor/a.go", excluded: true},
		{name: "Text", analyzer: "revive", path: "a.go", message: "package-comments: should have a package comment", excluded: true},
		{name: "TextOfOtherLinter", analyzer: "godot", path: "a.go", message: "should have a package comment"},
		{name: "Path", analyzer: "godot", path: "internal/a.go", excluded: true},
		{name: "PathExcept", analyzer: "godot", path: "internal/a_test.go"},
		{name: "Source", analyzer: "lll", path: "a.go", source: "//go:generate long", excluded: true},
		{name: "OtherSource", analyzer: "lll", path: "a.go", source: "var x = 1"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			finding := config.Finding{Analyzer: test.analyzer, Path: test.path, Message: test.message, Source: func() string { return test.source }}
			assert.Equal(t, test.excluded, excluder.Excluded(finding))
		})
	}
}

func TestExclusionErrors(t *testing.T) {
	tests := []struct {
		name   string
		config string
		err    string
	}{
		{"OnlyLinters", "[[exclude]]\nlinters = [\"lll\"]\n", "config.toml: exclude[0]: set path, path-except, text, or source; to turn analyzers off everywhere, use disable"},
		{"BadPattern", "[[exclude]]\ntext = '('\n", "config.toml: exclude[0]: text: error parsing regexp: missing closing ): `(`"},
		{"BadPath", "exclude-paths = ['[']\n", "config.toml: exclude-paths[0]: error parsing regexp: missing closing ]: `[`"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := config.Parse("config.toml", test.config)
			assert.EqualError(t, err, test.err)
		})
	}
}
