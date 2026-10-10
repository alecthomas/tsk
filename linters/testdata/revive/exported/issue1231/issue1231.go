// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package golint comment
package golint

// Deprecated: this is deprecated, use math.PI instead
const PI = 3.14 // want "^exported: exported const PI should have comment or be unexported$"

// Deprecated: this is deprecated
var Buffer []byte // want "^exported: exported var Buffer should have comment or be unexported$"

// Eq returns true if a == b, false otherwise.
// Deprecated: this is deprecated
func Eq(a, b int) bool {
	return a == b
}

// Deprecated: this is deprecated, use min instead
// Min returns a if a <= b, b otherwise.
func Min(a, b int) int { // want "^exported: exported function Min should have comment or be unexported$"
	if a < b {
		return a
	}
	return b
}

// Maximum returns a if a >= b, b otherwise. // want `^exported: comment on exported function Max should be of the form "Max ..."$`
// Deprecated: this is deprecated, use max instead
func Max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// Deprecated: this is deprecated
type Number float64 // want "^exported: exported type Number should have comment or be unexported$"

// Name is a type that represents a name.
type Name string

// Greet returns a greeting for the name.
func (n Name) Greet() string {
	return "Hello, " + string(n)
}

// Deprecated: this is deprecated, use Name.ToString instead
func (n Name) ToString() string { // want "^exported: exported method Name.ToString should have comment or be unexported$"
	return string(n)
}

// String returns the string representation of the name.
// Deprecated: this is deprecated, use Name.Greet instead
func (n Name) String() string {
	return string(n)
}
