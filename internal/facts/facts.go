// Package facts provides the Go fact types that carry script facts.
//
// go/analysis keys facts by Go type and requires pointer types with methods,
// which reflect cannot create at runtime. A fixed pool of named types is
// assigned to (analyzer, fact) pairs instead.
package facts

import (
	"reflect"

	"github.com/alecthomas/errors"
	"golang.org/x/tools/go/analysis"
)

//go:generate go run gen.go

// Payload holds a fact's name and JSON value.
type Payload struct {
	Name string
	Data []byte
}

// AFact marks Payload's embedders as analysis facts.
func (*Payload) AFact() {}

// String returns the name and JSON value, which analysistest matches against.
func (p *Payload) String() string { return p.Name + " " + string(p.Data) }

// JSON returns the fact's value.
func (p *Payload) JSON() []byte { return p.Data }

// Set replaces the fact's name and value.
func (p *Payload) Set(name string, data []byte) {
	p.Name = name
	p.Data = data
}

// Fact is a pooled fact type.
type Fact interface {
	analysis.Fact
	JSON() []byte
	String() string
	Set(name string, data []byte)
}

// Types returns n distinct fact types, as pointer types.
func Types(n int) ([]reflect.Type, error) {
	pool := pool()
	if n > len(pool) {
		return nil, errors.Errorf("%d facts declared; at most %d are supported", n, len(pool))
	}
	types := make([]reflect.Type, n)
	for i := range n {
		types[i] = reflect.TypeOf(pool[i])
	}
	return types, nil
}

// New returns a new fact of a type returned by Types.
func New(t reflect.Type) Fact {
	return reflect.New(t.Elem()).Interface().(Fact) //nolint:forcetypeassert // Types only returns pool types.
}
