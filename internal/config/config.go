// Package config loads .tsk/config.toml and decodes each analyzer's table
// against the config type its script declares.
package config

import (
	"fmt"
	"maps"
	"os"
	"reflect"
	"slices"

	"github.com/alecthomas/errors"
	ts "github.com/microsoft/TypeScript/tsc/shim/typescript"
	"github.com/pelletier/go-toml/v2"

	"github.com/alecthomas/tsk/internal/naming"
)

// FileName is the config file's name within the scripts directory.
const FileName = "config.toml"

// File is a parsed config file. Each top-level setting's help tag documents it
// in tsk config.
type File struct {
	Disable    []string `toml:"disable" help:"Analyzers that do not run."`
	DisableAll bool     `toml:"disable-all" help:"Turn every analyzer off except those listed in enable."`
	Enable     []string `toml:"enable" help:"Analyzers that run when disable-all is true."`
	// Tables maps analyzer names to their raw tables.
	Tables map[string]map[string]any `toml:"-"`
}

// Setting documents a top-level setting.
type Setting struct {
	Key string
	Doc string
	// Default is the setting's zero value, with slices empty rather than nil.
	Default any
}

// Settings lists the top-level settings, which are not analyzer tables, from
// File's struct tags.
func Settings() []Setting {
	file := reflect.TypeFor[File]()
	settings := make([]Setting, 0, file.NumField())
	for field := range file.Fields() {
		key := field.Tag.Get("toml")
		if key == "-" {
			continue
		}
		value := reflect.Zero(field.Type)
		if field.Type.Kind() == reflect.Slice {
			value = reflect.MakeSlice(field.Type, 0, 0)
		}
		settings = append(settings, Setting{Key: key, Doc: field.Tag.Get("help"), Default: value.Interface()})
	}
	return settings
}

func isSetting(key string) bool {
	return slices.ContainsFunc(Settings(), func(setting Setting) bool { return setting.Key == key })
}

// Enabled reports whether the config runs an analyzer.
func (f File) Enabled(name string) bool {
	if f.DisableAll {
		return slices.Contains(f.Enable, name)
	}
	return !slices.Contains(f.Disable, name)
}

// Load parses a config file. A missing file is an empty config.
func Load(path string) (File, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return File{Tables: map[string]map[string]any{}}, nil
	}
	if err != nil {
		return File{}, errors.Wrap(err, "read config")
	}
	return Parse(path, string(data))
}

// Parse parses config file contents; name is used in errors. Settings decode
// into typed fields, so the decoder checks them. Analyzer tables stay raw
// until their scripts' config types are known.
func Parse(name, text string) (File, error) {
	var file File
	if err := toml.Unmarshal([]byte(text), &file); err != nil {
		return File{}, decodeError(name, err)
	}
	var raw map[string]any
	if err := toml.Unmarshal([]byte(text), &raw); err != nil {
		return File{}, decodeError(name, err)
	}
	file.Tables = map[string]map[string]any{}
	for _, key := range slices.Sorted(maps.Keys(raw)) {
		if isSetting(key) {
			continue
		}
		table, ok := raw[key].(map[string]any)
		if !ok {
			return File{}, errors.Errorf("%s: %s must be a table named after an analyzer", name, key)
		}
		file.Tables[key] = table
	}
	// Each combination below would silently ignore a setting.
	switch {
	case len(file.Enable) > 0 && !file.DisableAll:
		return File{}, errors.Errorf("%s: enable needs disable-all = true; every analyzer already runs", name)
	case len(file.Disable) > 0 && file.DisableAll:
		return File{}, errors.Errorf("%s: disable has no effect with disable-all = true; list analyzers to run in enable", name)
	}
	return file, nil
}

// decodeError locates a decoding error as file:line:column when the decoder
// knows the position.
func decodeError(name string, err error) error {
	var decode *toml.DecodeError
	if errors.As(err, &decode) {
		row, column := decode.Position()
		return errors.Errorf("%s:%d:%d: %s", name, row, column, decode.Error())
	}
	return errors.Wrapf(err, "parse %s", name)
}

// ValidateShape reports property names that cannot map to TOML keys.
func ValidateShape(shape ts.Shape) error {
	switch shape := shape.(type) {
	case ts.ArrayShape:
		return ValidateShape(shape.Element)
	case ts.RecordShape:
		return ValidateShape(shape.Element)
	case ts.ObjectShape:
		_, err := keys(shape)
		return err
	}
	return nil
}

// keys maps each TOML key to its property, validating nested shapes.
func keys(object ts.ObjectShape) (map[string]ts.Property, error) {
	properties := map[string]ts.Property{}
	for _, property := range object.Properties {
		key, err := naming.Kebab(property.Name)
		if err != nil {
			return nil, errors.WithStack(err)
		}
		if other, duplicate := properties[key]; duplicate {
			return nil, errors.Errorf("properties %s and %s both map to TOML key %q", other.Name, property.Name, key)
		}
		if err := ValidateShape(property.Shape); err != nil {
			return nil, err
		}
		properties[key] = property
	}
	return properties, nil
}

// Resolve decodes an analyzer's table and merges it over its defaults, which
// are the JSON-decoded config property. Without a shape, the table must be
// empty. Objects merge key by key; arrays replace.
func Resolve(analyzer string, shape ts.Shape, defaults any, table map[string]any) (any, error) {
	object, ok := shape.(ts.ObjectShape)
	if !ok {
		if len(table) > 0 {
			key := slices.Sorted(maps.Keys(table))[0]
			return nil, errors.Errorf("%s.%s: analyzer %s has no config", analyzer, key, analyzer)
		}
		return map[string]any{}, nil
	}
	base, _ := defaults.(map[string]any)
	return mergeObject(analyzer, object, base, table)
}

func mergeObject(path string, object ts.ObjectShape, defaults map[string]any, table map[string]any) (map[string]any, error) {
	properties, err := keys(object)
	if err != nil {
		return nil, err
	}
	merged := maps.Clone(defaults)
	if merged == nil {
		merged = map[string]any{}
	}
	for _, key := range slices.Sorted(maps.Keys(table)) {
		property, ok := properties[key]
		if !ok {
			return nil, errors.Errorf("%s.%s: unknown key", path, key)
		}
		value, err := decode(path+"."+key, property.Shape, merged[property.Name], table[key])
		if err != nil {
			return nil, err
		}
		merged[property.Name] = value
	}
	return merged, nil
}

func decode(path string, shape ts.Shape, defaults any, value any) (any, error) {
	switch shape := shape.(type) {
	case ts.StringShape:
		if text, ok := value.(string); ok {
			return text, nil
		}
		return nil, mismatch(path, "a string", value)
	case ts.NumberShape:
		switch number := value.(type) {
		case int64:
			return float64(number), nil
		case float64:
			return number, nil
		}
		return nil, mismatch(path, "a number", value)
	case ts.BooleanShape:
		if flag, ok := value.(bool); ok {
			return flag, nil
		}
		return nil, mismatch(path, "a boolean", value)
	case ts.EnumShape:
		if text, ok := value.(string); ok && slices.Contains(shape.Values, text) {
			return text, nil
		}
		return nil, mismatch(path, fmt.Sprintf("one of %q", shape.Values), value)
	case ts.ArrayShape:
		return decodeArray(path, shape, value)
	case ts.RecordShape:
		return decodeRecord(path, shape, defaults, value)
	case ts.ObjectShape:
		table, ok := value.(map[string]any)
		if !ok {
			return nil, mismatch(path, "a table", value)
		}
		base, _ := defaults.(map[string]any)
		return mergeObject(path, shape, base, table)
	}
	return nil, errors.Errorf("%s: unsupported shape %T", path, shape)
}

func decodeArray(path string, shape ts.ArrayShape, value any) (any, error) {
	items, ok := value.([]any)
	if !ok {
		return nil, mismatch(path, "an array", value)
	}
	decoded := make([]any, 0, len(items))
	for i, item := range items {
		element, err := decode(fmt.Sprintf("%s[%d]", path, i), shape.Element, nil, item)
		if err != nil {
			return nil, err
		}
		decoded = append(decoded, element)
	}
	return decoded, nil
}

// decodeRecord keeps keys as written, because they are data.
func decodeRecord(path string, shape ts.RecordShape, defaults any, value any) (any, error) {
	table, ok := value.(map[string]any)
	if !ok {
		return nil, mismatch(path, "a table", value)
	}
	base, _ := defaults.(map[string]any)
	merged := maps.Clone(base)
	if merged == nil {
		merged = map[string]any{}
	}
	for _, key := range slices.Sorted(maps.Keys(table)) {
		element, err := decode(path+"."+key, shape.Element, merged[key], table[key])
		if err != nil {
			return nil, err
		}
		merged[key] = element
	}
	return merged, nil
}

func mismatch(path, expected string, value any) error {
	return errors.Errorf("%s: expected %s, got %s", path, expected, describe(value))
}

func describe(value any) string {
	switch value.(type) {
	case string:
		return "a string"
	case int64, float64:
		return "a number"
	case bool:
		return "a boolean"
	case []any:
		return "an array"
	case map[string]any:
		return "a table"
	}
	return fmt.Sprintf("%T", value)
}
