// Adapted from github.com/maratori/testableexamples's tests, MIT License.
package whole // want "^missing output for example, go test can't validate it$"

import "fmt"

const greeting = "hello"

func Example() {
	fmt.Println(greeting)
}
