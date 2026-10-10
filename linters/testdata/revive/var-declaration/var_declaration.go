// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package foo ...
package foo

import (
	"fmt"
	"io"
	"net/http"
	"nosuchpkg" // export data unavailable
	"os"
)

// Q is a test type.
type Q bool

var myInt int = 7                           // want `^var-declaration: should omit type int from declaration of var myInt; it will be inferred from the right-hand side$`
var mux *http.ServeMux = http.NewServeMux() // want `^var-declaration: should omit type \*http\.ServeMux from declaration of var mux; it will be inferred from the right-hand side$`

var myZeroInt int = 0         // want `^var-declaration: should drop = 0 from declaration of var myZeroInt; it is the zero value$`
var myZeroFlt float32 = 0.    // want `^var-declaration: should drop = 0\. from declaration of var myZeroFlt; it is the zero value$`
var myZeroF64 float64 = 0.0   // want `^var-declaration: should drop = 0\.0 from declaration of var myZeroF64; it is the zero value$`
var myZeroImg complex64 = 0i  // want `^var-declaration: should drop = 0i from declaration of var myZeroImg; it is the zero value$`
var myZeroStr string = ""     // want `^var-declaration: should drop = "" from declaration of var myZeroStr; it is the zero value$`
var myZeroRaw string = ``     // want "^var-declaration: should drop = `` from declaration of var myZeroRaw; it is the zero value$"
var myZeroPtr *Q = nil        // want `^var-declaration: should drop = nil from declaration of var myZeroPtr; it is the zero value$`
var myZeroRune rune = '\x00'  // want `^var-declaration: should drop = '\\x00' from declaration of var myZeroRune; it is the zero value$`
var myZeroRune2 rune = '\000' // want `^var-declaration: should drop = '\\000' from declaration of var myZeroRune2; it is the zero value$`

// No warning because there's no type on the LHS
var x = 0

// This shouldn't get a warning because there's no initial values.
var str fmt.Stringer

// No warning because this is a const.
const k uint64 = 7

const num = 123

// No warning because the var's RHS is known to be an untyped const.
var flags uint32 = num

// No warnings because the RHS is an ideal int, and the LHS is a different int type.
var userID int64 = 1235
var negID int64 = -1
var parenID int64 = (17)
var crazyID int64 = -(-(-(-9)))

// Same, but for strings and floats.
type stringT string
type floatT float64

var stringV stringT = "abc"
var floatV floatT = 123.45

// No warning because the LHS names an interface type.
var data interface{} = googleIPs
var googleIPs []int

// No warning because it's a common idiom for interface satisfaction.
var _ Server = (*serverImpl)(nil)

// Server is a test type.
type Server interface{}
type serverImpl struct{}

// LHS is a different type than the RHS.
var myStringer fmt.Stringer = q(0)

// LHS is a different type than the RHS.
var out io.Writer = os.Stdout

var out2 io.Writer = newWriter() // want `^var-declaration: should omit type io\.Writer from declaration of var out2; it will be inferred from the right-hand side$`

func newWriter() io.Writer { return nil }

// We don't figure out the true types of LHS and RHS here,
// so we suppress the check.
var ni nosuchpkg.Interface = nosuchpkg.NewConcrete()

var y string = q(1).String() // want `^var-declaration: should omit type string from declaration of var y; it will be inferred from the right-hand side$`

type q int

func (q) String() string { return "I'm a q" }

// The only true zero value for any/interface{} is nil. Others will be considered non-zero.
var z1 any = 0           // No warning, zero value for any is nil
var z2 any = nil         // want `^var-declaration: should drop = nil from declaration of var z2; it is the zero value$`
var z3 interface{} = 0   // No warning, zero value for any is nil
var z4 interface{} = nil // want `^var-declaration: should drop = nil from declaration of var z4; it is the zero value$`

func local() {
	var s string = "local"  // want `^var-declaration: should omit type string from declaration of var s; it will be inferred from the right-hand side$`
	var f func() = func() { // want `^var-declaration: should omit type func\(\) from declaration of var f; it will be inferred from the right-hand side$`
		var n int = 0 // not visited: revive skips value specs' children
		_ = n
	}
	_, _ = s, f
}
