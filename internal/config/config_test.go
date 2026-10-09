package config_test

import (
	"testing"

	"github.com/alecthomas/assert/v2"
	"github.com/alecthomas/kong"
	ts "github.com/microsoft/TypeScript/tsc/shim/typescript"

	"github.com/alecthomas/tsk/internal/config"
)

func TestLintSelectionFlags(t *testing.T) {
	var selection config.LintSelection
	parser, err := kong.New(&selection)
	assert.NoError(t, err)
	_, err = parser.Parse([]string{"--enable-all", "--disable=a,b"})
	assert.NoError(t, err)
	assert.Equal(t, config.LintSelection{Disable: []string{"a", "b"}, EnableAll: true}, selection)
	_, err = parser.Parse([]string{"--enable-all", "--disable-all"})
	assert.EqualError(t, err, "--disable-all and --enable-all can't be used together")
}

func encapsulationShape() ts.Shape {
	rule := ts.ObjectShape{Properties: []ts.Property{
		{Name: "writer", Shape: ts.StringShape{}},
		{Name: "target", Shape: ts.StringShape{}},
	}}
	return ts.ObjectShape{Properties: []ts.Property{
		{Name: "allowReads", Shape: ts.ArrayShape{Element: rule}},
		{Name: "allowGeneratedConstruction", Shape: ts.BooleanShape{}},
		{Name: "mode", Optional: true, Shape: ts.EnumShape{Values: []string{"loose", "strict"}}},
		{Name: "limits", Shape: ts.RecordShape{Element: ts.NumberShape{}}},
	}}
}

func TestResolve(t *testing.T) {
	file, err := config.Parse("test.toml", `
disable = ["optionalnil"]

[encapsulation]
allow-generated-construction = true
mode = "strict"
limits = { Fields = 3 }

[[encapsulation.allow-reads]]
writer = "visit"
target = "node"
`)
	assert.NoError(t, err)
	assert.Equal(t, []string{"optionalnil"}, file.Disable)
	defaults := map[string]any{
		"allowReads":                 []any{map[string]any{"writer": "all", "target": "all"}},
		"allowGeneratedConstruction": false,
		"limits":                     map[string]any{"Methods": 1.0},
	}
	resolved, err := config.Resolve("encapsulation", encapsulationShape(), defaults, file.Tables["encapsulation"])
	assert.NoError(t, err)
	assert.Equal(t, any(map[string]any{
		"allowReads":                 []any{map[string]any{"writer": "visit", "target": "node"}},
		"allowGeneratedConstruction": true,
		"mode":                       "strict",
		"limits":                     map[string]any{"Methods": 1.0, "Fields": 3.0},
	}), resolved)
}

func TestResolveErrors(t *testing.T) {
	tests := []struct {
		Name  string
		Table string
		Error string
	}{
		{Name: "UnknownKey", Table: `allowReads = []`, Error: "encapsulation.allowReads: unknown key"},
		{Name: "WrongType", Table: `allow-generated-construction = "yes"`, Error: "encapsulation.allow-generated-construction: expected a boolean, got a string"},
		{Name: "BadEnum", Table: `mode = "lax"`, Error: `encapsulation.mode: expected one of ["loose" "strict"], got a string`},
		{Name: "NestedKey", Table: "[[encapsulation.allow-reads]]\nwriter = 1", Error: "encapsulation.allow-reads[0].writer: expected a string, got a number"},
	}
	for _, test := range tests {
		t.Run(test.Name, func(t *testing.T) {
			file, err := config.Parse("test.toml", "[encapsulation]\n"+test.Table)
			assert.NoError(t, err)
			_, err = config.Resolve("encapsulation", encapsulationShape(), nil, file.Tables["encapsulation"])
			assert.EqualError(t, err, test.Error)
		})
	}
}

func TestResolveWithoutConfig(t *testing.T) {
	_, err := config.Resolve("optionalnil", nil, nil, map[string]any{"strict": true})
	assert.EqualError(t, err, "optionalnil.strict: analyzer optionalnil has no config")
}

func TestEnabled(t *testing.T) {
	tests := []struct {
		Name      string
		Text      string
		Selection config.Selection
		EnableAll bool
		Enabled   []string
		Error     string
	}{
		{Name: "SelectEnableAll", Text: "disable-all = true\nenable = [\"b\"]", EnableAll: true, Selection: config.Selection{Disable: []string{"c"}}, Enabled: []string{"a", "b"}},
		{Name: "SelectEnableAllOverridesDisable", Text: `disable = ["a"]`, EnableAll: true, Enabled: []string{"a", "b", "c"}},
		{Name: "Default", Text: ``, Enabled: []string{"a", "b", "c"}},
		{Name: "Disable", Text: `disable = ["a"]`, Enabled: []string{"b", "c"}},
		{Name: "DisableAll", Text: `disable-all = true`},
		{Name: "DisableAllEnable", Text: "disable-all = true\nenable = [\"b\"]", Enabled: []string{"b"}},
		{Name: "SelectDisable", Text: `disable = ["a"]`, Selection: config.Selection{Disable: []string{"b"}}, Enabled: []string{"c"}},
		{Name: "SelectEnableOverridesDisable", Text: `disable = ["a", "b"]`, Selection: config.Selection{Enable: []string{"a"}}, Enabled: []string{"a", "c"}},
		{Name: "SelectEnableWithDisableAll", Text: "disable-all = true\nenable = [\"b\"]", Selection: config.Selection{Enable: []string{"c"}}, Enabled: []string{"b", "c"}},
		{Name: "SelectDisableWithDisableAll", Text: "disable-all = true\nenable = [\"b\", \"c\"]", Selection: config.Selection{Disable: []string{"b"}}, Enabled: []string{"c"}},
		{Name: "SelectDisableAllIgnoresConfig", Text: "disable-all = true\nenable = [\"b\"]", Selection: config.Selection{DisableAll: true, Enable: []string{"a"}}, Enabled: []string{"a"}},
		{Name: "SelectDisableWinsOverEnable", Selection: config.Selection{Enable: []string{"a"}, Disable: []string{"a"}}, Enabled: []string{"b", "c"}},
		{Name: "SelectDisableAllDisableWinsOverEnable", Selection: config.Selection{DisableAll: true, Enable: []string{"a", "b"}, Disable: []string{"a"}}, Enabled: []string{"b"}},
		{Name: "EnableWithoutDisableAll", Text: `enable = ["b"]`, Error: "test.toml: enable needs disable-all = true; every analyzer already runs"},
		{Name: "DisableWithDisableAll", Text: "disable-all = true\ndisable = [\"a\"]", Error: "test.toml: disable has no effect with disable-all = true; list analyzers to run in enable"},
		{Name: "DisableAllNotBool", Text: `disable-all = "yes"`, Error: "test.toml:1:15: toml: cannot decode TOML string"},
	}
	for _, test := range tests {
		t.Run(test.Name, func(t *testing.T) {
			file, err := config.Parse("test.toml", test.Text)
			if test.Error != "" {
				assert.Error(t, err)
				assert.Contains(t, err.Error(), test.Error)
				return
			}
			assert.NoError(t, err)
			file = file.SelectLint(config.LintSelection{Selection: test.Selection, EnableAll: test.EnableAll})
			var enabled []string
			for _, name := range []string{"a", "b", "c"} {
				if file.Enabled(name) {
					enabled = append(enabled, name)
				}
			}
			assert.Equal(t, test.Enabled, enabled)
		})
	}
}

func TestValidateShape(t *testing.T) {
	err := config.ValidateShape(ts.ObjectShape{Properties: []ts.Property{{Name: "allow_reads", Shape: ts.StringShape{}}}})
	assert.EqualError(t, err, `property name "allow_reads" cannot map to a TOML key; use lowerCamelCase`)
}
