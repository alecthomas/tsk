// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package foo ...
package foo

type hidden struct{}

// Exported returns a hidden type, which is annoying.
func Exported() hidden { // want `^unexported-return: exported func Exported returns unexported type foo\.hidden, which can be annoying to use$`
	return hidden{}
}

// ExpErr returns a builtin type.
func ExpErr() error { // ok
	return nil
}

func (h hidden) ExpOnHidden() hidden { // ok
	return h
}

func (hidden) ForInterface() error {
	return nil
}

// Interface is exported.
type Interface interface {
	ForInterface() error
}

// ExportedAsInterface returns a hidden type as an exported interface, which is fine.
func ExportedAsInterface() Interface { // ok
	return Exported()
}

// T is another test type.
type T struct{}

// MethodOnT returns a hidden type, which is annoying.
func (T) MethodOnT() hidden { // want `^unexported-return: exported method MethodOnT returns unexported type foo\.hidden, which can be annoying to use$`
	return hidden{}
}

// ExpT returns a T.
func ExpT() T { // ok
	return T{}
}

func unexp() hidden { // ok
	return hidden{}
}

// This is slightly sneaky: we shadow the builtin "int" type.

type int struct{}

// ExportedIntReturner returns an unexported type from this package.
func ExportedIntReturner() int { // want `^unexported-return: exported func ExportedIntReturner returns unexported type foo\.int, which can be annoying to use$`
	return int{}
}

type unexportedInterface interface {
	ForInterface() error
}

// ExportedInterfaceReturner returns an unexported interface type, which is annoying.
func ExportedInterfaceReturner() unexportedInterface { // want `^unexported-return: exported func ExportedInterfaceReturner returns unexported type foo\.unexportedInterface, which can be annoying to use$`
	return hidden{}
}

// ExportedInterfaceSliceReturner returns a slice of an unexported interface type, which is annoying.
func ExportedInterfaceSliceReturner() []unexportedInterface { // want `^unexported-return: exported func ExportedInterfaceSliceReturner returns unexported type \[\]foo\.unexportedInterface, which can be annoying to use$`
	return nil
}

// ExportedMapReturner returns a map with an unexported value type.
func ExportedMapReturner() (string, map[string]*hidden) { // want `^unexported-return: exported func ExportedMapReturner returns unexported type map\[string\]\*foo\.hidden, which can be annoying to use$`
	return "", nil
}

// ExportedInterface is an exported alias of an unexported interface type.
type ExportedInterface = unexportedInterface

// ExportedInterfaceAliasReturner returns an unexported interface type through an exported alias, which is fine.
func ExportedInterfaceAliasReturner() ExportedInterface { // ok
	return hidden{}
}

type config struct {
	N int
}

// Option ...
type Option = option

type option func(*config)

// WithN ...
func WithN(n int) Option {
	return func(c *config) {
		c.N = n
	}
}

type b = A

// A ...
type A func(*config)

// WithA ...
func WithA(n int) b { // want `^unexported-return: exported func WithA returns unexported type foo\.b, which can be annoying to use$`
	return func(c *config) {
		c.N = n
	}
}
