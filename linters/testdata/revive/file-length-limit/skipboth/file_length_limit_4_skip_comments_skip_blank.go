// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

import "fmt"

// Foo is a function.
func Foo(a, b int) {
	fmt.Println("Hello, world!")
}

// want "^file-length-limit: file length is 5 lines, which exceeds the limit of 4$"
