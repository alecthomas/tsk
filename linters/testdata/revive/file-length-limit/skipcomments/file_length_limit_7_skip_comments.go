// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

import "fmt"

// Foo is a function.
func Foo(a, b int) {
	// This
	/* is
	a
	*/
	// a comment.
	fmt.Println("Hello, world!")
	/*
		This is
		multiline
		comment.
	*/
}

// want "^file-length-limit: file length is 9 lines, which exceeds the limit of 8$"
