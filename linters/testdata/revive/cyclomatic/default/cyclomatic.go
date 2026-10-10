// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package cyclomaticdefault tests cyclomatic with the default limit.
package cyclomaticdefault

import "log"

func f(x int) bool { // want "^cyclomatic: function f has cyclomatic complexity 11 \\(> max enabled 10\\)$"
	if x > 0 && true || false {
		return true
	} else {
		log.Printf("non-positive x: %d", x)
	}
	switch x {
	case 1:
	case 2:
	case 3:
	case 4:
	default:
	}
	return true || true && true
}

type T struct{}

func (*T) m(x int) bool { // want "^cyclomatic: function \\(\\*T\\).m has cyclomatic complexity 11 \\(> max enabled 10\\)$"
	if x > 0 && true || false {
		return true
	}
	for range x {
		if x > 1 && x < 5 {
			return false
		}
	}
	select {
	case <-make(chan int):
	default:
	}
	return true || true && true
}
