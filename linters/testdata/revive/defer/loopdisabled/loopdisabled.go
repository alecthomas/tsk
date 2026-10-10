// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package loopdisabled tests defer without its loop check.
package loopdisabled

import "errors"

type tt int

func (t tt) m() {}

func deferrer() {
	for {
		go func() {
			defer println()
		}()
		defer func() {}()
		break
	}

	defer tt.m(0) // want "^defer: be careful when deferring calls to methods without pointer receiver$"

	defer func() error {
		return errors.New("error") // want "^defer: return in a defer function has no effect$"
	}()

	defer recover()

	recover() // want "^defer: recover must be called inside a deferred function$"

	defer deferrer()
}
