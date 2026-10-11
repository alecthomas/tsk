// Adapted from github.com/mgechev/revive's tests, MIT License.

package foo

// this is a test file in a package
//
// such files SHOULD NOT be linted by unexported_return rule
// because symbols defined in test files cannot be used in other packages

type bar struct{}

func NewBar() bar {
	return bar{}
}
