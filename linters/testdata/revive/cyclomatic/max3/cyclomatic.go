// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package max3 tests cyclomatic with a limit of three.
package max3

import "log"

func f(x int) bool { // want "^cyclomatic: function f has cyclomatic complexity 4 \\(> max enabled 3\\)$"
	if x > 0 && true || false {
		return true
	} else {
		log.Printf("non-positive x: %d", x)
	}
	return false
}

func g(f func() bool) string {
	if ok := f(); ok {
		return "it's okay"
	} else {
		return "it's NOT okay!"
	}
}
