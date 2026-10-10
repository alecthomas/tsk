// Adapted from github.com/leighmcculloch/gochecknoinits's tests, MIT license.
package inits

func init() {} // want "^don't use `init` function$"

func init() { // want "^don't use `init` function$"
	_ = 1
}

type S struct{}

// A method named init is allowed.
func (S) init() {}

func function() {
	init := func() {}
	init()
}
