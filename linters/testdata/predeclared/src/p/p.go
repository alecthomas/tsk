// Adapted from github.com/nishanths/predeclared's tests, MIT License.
package p

import real "strings" // want "^import name real has same name as predeclared identifier$"

const true = false // want "^const true has same name as predeclared identifier$"

var len = 1 // want "^variable len has same name as predeclared identifier$"

type error struct { // want "^type error has same name as predeclared identifier$"
	string int
}

type iface interface {
	copy()
}

func new(cap int) (min int) { // want "^function new has same name as predeclared identifier$" "^param cap has same name as predeclared identifier$" "^named return min has same name as predeclared identifier$"
	_ = real.ToLower
	return 0
}

func (any error) append() {} // want "^receiver any has same name as predeclared identifier$"

func _() {
	max := 1 // want "^variable max has same name as predeclared identifier$"
	_ = max
print: // want "^label print has same name as predeclared identifier$"
	goto print
}
