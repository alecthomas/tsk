// Adapted from github.com/mgechev/revive's tests, MIT License.

package foo

// this is a file in a package
//
// such files SHOULD be linted by unexported_return rule
// because symbols defined in test files cannot be used in other packages

type foo struct{}

func NewFoo() foo { // want `^unexported-return: exported func NewFoo returns unexported type foo\.foo, which can be annoying to use$`
	return foo{}
}
