// Package bindings holds the generated registry of Go packages exposed to
// scripts and their TypeScript declarations.
package bindings

import (
	"embed"
	"reflect"
)

//go:generate tsk-gen --output .

// Declarations holds one ambient module declaration per exposed package.
//
//go:embed dts/*.d.ts
var Declarations embed.FS

// Package is one exposed Go package. Maps are keyed by Go name.
type Package struct {
	Path   string
	Funcs  map[string]any
	Vars   map[string]func() any
	Consts map[string]any
	Types  map[string]reflect.Type
	// ErrorVars names the variables declared as error classes.
	ErrorVars []string
	// ErrorTypes names the types declared as error classes.
	ErrorTypes []string
}
