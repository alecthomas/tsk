// Adapted from github.com/mgechev/revive's tests, MIT License.

package main

// this is a test file in the main package
//
// such files SHOULD NOT be linted by unexported_return rule
// because symbols defined in main package cannot be imported in other packages

type bar struct{}

func NewBar() bar {
	return bar{}
}
