// Package naming maps Go and TypeScript names to the names scripts and config
// files use. The binding generator and the runtime must agree on every rule.
package naming

import (
	"slices"
	"strings"
	"unicode"

	"github.com/alecthomas/errors"
)

// Member maps an exported Go field, method, or function name to lowerCamelCase.
// A leading initialism is lowercased as a unit, so "URL" is "url" and
// "ASTNode" is "astNode".
func Member(name string) string {
	runes := []rune(name)
	upper := 0
	for upper < len(runes) && unicode.IsUpper(runes[upper]) {
		upper++
	}
	// Keep the capital that starts the next word, as in "ASTNode".
	if upper > 1 && upper < len(runes) && unicode.IsLower(runes[upper]) {
		upper--
	}
	for i := range upper {
		runes[i] = unicode.ToLower(runes[i])
	}
	return string(runes)
}

// Function maps an exported Go function name to the name a module exports.
// It is Member, made a valid binding name, so inspector.New is "new_".
func Function(name string) string {
	return Identifier(Member(name))
}

// Identifier suffixes a JavaScript reserved word with "_" so it can name a
// binding or parameter.
func Identifier(name string) string {
	if slices.Contains(reservedWords(), name) {
		return name + "_"
	}
	return name
}

func reservedWords() []string {
	return []string{
		"arguments", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
		"delete", "do", "else", "enum", "eval", "export", "extends", "false", "finally", "for", "function",
		"if", "implements", "import", "in", "instanceof", "interface", "let", "new", "null", "package",
		"private", "protected", "public", "return", "static", "super", "switch", "this", "throw", "true",
		"try", "typeof", "var", "void", "while", "with", "yield",
	}
}

// Kebab maps a lowerCamelCase TypeScript property name to its TOML key, so
// "allowReads" is "allow-reads". Names containing "-" or "_" are rejected
// because the mapping could not be reversed unambiguously.
func Kebab(name string) (string, error) {
	if name == "" || strings.ContainsAny(name, "-_") {
		return "", errors.Errorf("property name %q cannot map to a TOML key; use lowerCamelCase", name)
	}
	var key strings.Builder
	for i, r := range name {
		if unicode.IsUpper(r) {
			if i > 0 {
				key.WriteByte('-')
			}
			r = unicode.ToLower(r)
		}
		key.WriteRune(r)
	}
	return key.String(), nil
}
