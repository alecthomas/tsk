// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package customregex tests unused-receiver with allow-regex "^xxx".
package customregex

type SomeObj struct{}

func (xxxParam *SomeObj) f0() {}

// still works with _

func (_ *SomeObj) f1() {}

func (yyyParam *SomeObj) f2() { // want "^unused-receiver: method receiver 'yyyParam' is not referenced in method's body, consider removing or renaming it to match \\^xxx$"
}
