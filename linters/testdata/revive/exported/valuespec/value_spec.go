// Adapted from github.com/mgechev/revive's tests, MIT License.

// Test that exported names have correct comments.

// Package pkg does something.
package pkg

import "time"

type T int // want "^exported: exported type T should have comment or be unexported$"

func (T) F() {} // want "^exported: exported method T.F should have comment or be unexported$"

// this is a nice type. // want `^exported: comment on exported type U should be of the form "U ..." \(with optional leading article\)$`
type U string

// this is a neat function. // want `^exported: comment on exported method U.G should be of the form "G ..."$`
func (U) G() {}

// A V is a string.
type V string

// V.H has a pointer receiver

func (*V) H() {} // want "^exported: exported method V.H should have comment or be unexported$"

var W = "foo" // want "^exported: exported var W should have comment or be unexported$"

const X = "bar" // want "^exported: exported const X should have comment or be unexported$"

var Y, Z int // want "^exported: exported var Z should have its own declaration$"

// Location should be okay, since the other var name is an underscore.
var Location, _ = time.LoadLocation("Europe/Istanbul") // not Constantinople

// this is improperly documented // want `^exported: comment on exported const Thing should be of the form "Thing ..."$`
const Thing = "wonderful"
