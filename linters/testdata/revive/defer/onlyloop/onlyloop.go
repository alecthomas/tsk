// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package onlyloop tests defer with only its loop check.
package onlyloop

import "errors"

type tt int

func (t tt) m() {}

func deferrer() {
	for {
		go func() {
			defer println()
		}()
		defer func() {}() // want "^defer: prefer not to defer inside loops$"
		break
	}

	defer tt.m(0)

	defer func() error {
		return errors.New("error")
	}()

	defer recover()

	recover()

	defer deferrer()
}
