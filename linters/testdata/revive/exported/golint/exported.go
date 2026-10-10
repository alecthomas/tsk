// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package golint comment
package golint

import "net/http"

// GolintFoo is a dummy function
func GolintFoo() {} // want "^exported: func name will be used as golint.GolintFoo by other packages, and that stutters; consider calling this Foo$"

type (
	// O is a shortcut (alias) for map[string]interface{}, e.g. a JSON object.
	O = map[string]interface{}

	// A is shortcut for []O.
	A = []O

	// This Person type is simple
	Person = map[string]interface{}
)

type Foo struct{} // want "^exported: exported type Foo should have comment or be unexported$"

// The following cases are no-regression tests for issue 229

/* Bar something */
type Bar struct{}

/* Toto something */
func Toto() {}

/* FirstLetter something */
const FirstLetter = "A"

/*Bar2 something */
type Bar2 struct{}

/* Bar3 */ // want `^exported: comment on exported type Bar3 should be of the form "Bar3 ..." \(with optional leading article\)$`
type Bar3 struct{}

/* BarXXX invalid */ // want `^exported: comment on exported type Bar4 should be of the form "Bar4 ..." \(with optional leading article\)$`
type Bar4 struct{}

/*Toto2 something */
func Toto2() {}

/*SecondLetter something */
const SecondLetter = "B"

// T has methods with common names.
type T struct{}

// Tests for common method names
// Should NOT fail for methods
func (T) Error() string                                    { return "" }
func (T) String() string                                   { return "" }
func (T) ServeHTTP(w http.ResponseWriter, r *http.Request) {}
func (T) Read(p []byte) (n int, err error)                 { return 0, nil }
func (T) Write(p []byte) (n int, err error)                { return 0, nil }
func (T) Unwrap(err error) error                           { return nil }

// Should fail for functions

func Error() string                                    { return "" }     // want "^exported: exported function Error should have comment or be unexported$"
func String() string                                   { return "" }     // want "^exported: exported function String should have comment or be unexported$"
func ServeHTTP(w http.ResponseWriter, r *http.Request) {}                // want "^exported: exported function ServeHTTP should have comment or be unexported$"
func Read(p []byte) (n int, err error)                 { return 0, nil } // want "^exported: exported function Read should have comment or be unexported$"
func Write(p []byte) (n int, err error)                { return 0, nil } // want "^exported: exported function Write should have comment or be unexported$"
func Unwrap(err error) error                           { return nil }    // want "^exported: exported function Unwrap should have comment or be unexported$"
