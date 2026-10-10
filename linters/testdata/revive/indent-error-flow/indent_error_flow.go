// Adapted from github.com/mgechev/revive's tests, MIT License.

// Test of return+else warning.

// Package pkg ...
package indenterrorflow

import "log"

var err error

var author struct{ ErrCourseNotFound, ErrCourseAccess, AnotherError error }

func f(x int) bool {
	if x > 0 {
		return true
	} else { // want `^indent-error-flow: if block ends with a return statement, so drop this else and outdent its block$`
		log.Printf("non-positive x: %d", x)
	}
	return false
}

func g(f func() bool) string {
	if ok := f(); ok {
		return "it's okay"
	} else { // want `^indent-error-flow: if block ends with a return statement, so drop this else and outdent its block \(move short variable declaration to its own line if necessary\)$`
		return "it's NOT okay!"
	}
}

func h(f func() bool, x int) string {
	if err == author.ErrCourseNotFound {
		return ""
	} else if err == author.ErrCourseAccess {
		// side effect
	} else if err == author.AnotherError {
		return "okay"
	} else {
		if ok := f(); ok {
			return "it's okay"
		} else { // want `^indent-error-flow: if block ends with a return statement, so drop this else and outdent its block \(move short variable declaration to its own line if necessary\)$`
			return "it's NOT okay!"
		}
	}
	return ""
}

func i() string {
	if err == author.ErrCourseNotFound {
		return "not found"
	} else if err == author.AnotherError {
		return "something else"
	} else { // want `^indent-error-flow: if block ends with a return statement, so drop this else and outdent its block$`
		return "okay"
	}
}
