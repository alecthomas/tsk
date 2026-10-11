// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package pkg tests that use-any is off before Go 1.18.
package pkg

var i interface{}

type t interface{}

func any1(a interface{}) {
	m1 := map[interface{}]string{}
	_ = m1
}
