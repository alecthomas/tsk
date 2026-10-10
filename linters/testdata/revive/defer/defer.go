// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package deferrule tests defer.
package deferrule

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

	defer tt.m(0) // want "^defer: be careful when deferring calls to methods without pointer receiver$"

	defer func() error {
		return errors.New("error") // want "^defer: return in a defer function has no effect$"
	}()

	defer recover() // want "^defer: recover must be called inside a deferred function, this is executing recover immediately$"

	recover() // want "^defer: recover must be called inside a deferred function$"

	defer deferrer()

	helper := func(_ interface{}) {}

	defer helper(recover()) // want "^defer: recover must be called inside a deferred function, this is executing recover immediately$"

	// does not work, but not currently blocked.
	defer helper(func() { recover() })
}

// Issue #863

func verify(fn func() error) {
	if err := fn(); err != nil {
		panic(err)
	}
}

func f() {
	defer verify(func() error {
		return nil
	})
}

// Issue #1029
func verify2(a any) func() {
	return func() {
		fn := a.(func() error)
		if err := fn(); err != nil {
			panic(err)
		}
	}

}

func mainf() {
	defer verify2(func() error { // want "^defer: prefer not to defer chains of function calls$"
		return nil
	})()
}

// Issue #1528
func issue1528() {
	var fn func() int
	defer func() {
		fn = func() int {
			return 0
		}
	}()

	fn()
}
