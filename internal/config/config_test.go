package config_test

import (
	"testing"

	"github.com/alecthomas/assert/v2"
	ts "github.com/microsoft/TypeScript/tsc/shim/typescript"

	"github.com/alecthomas/tsktsk/internal/config"
)

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
		Name    string
		Text    string
		Enabled []string
		Error   string
	}{
		{Name: "Default", Text: ``, Enabled: []string{"a", "b"}},
		{Name: "Disable", Text: `disable = ["a"]`, Enabled: []string{"b"}},
		{Name: "DisableAll", Text: `disable-all = true`},
		{Name: "DisableAllEnable", Text: "disable-all = true\nenable = [\"b\"]", Enabled: []string{"b"}},
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
			var enabled []string
			for _, name := range []string{"a", "b"} {
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
