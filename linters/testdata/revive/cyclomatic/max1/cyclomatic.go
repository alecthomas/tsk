// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package max1 tests cyclomatic with a limit of one.
package max1

import "log"

func f(x int) bool { // want "^cyclomatic: function f has cyclomatic complexity 4 \\(> max enabled 1\\)$"
	if x > 0 && true || false {
		return true
	} else {
		log.Printf("non-positive x: %d", x)
	}
	return false
}

func g(f func() bool) string { // want "^cyclomatic: function g has cyclomatic complexity 2 \\(> max enabled 1\\)$"
	if ok := f(); ok {
		return "it's okay"
	} else {
		return "it's NOT okay!"
	}
}

func h() {}
