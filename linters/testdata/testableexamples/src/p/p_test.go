// Adapted from github.com/maratori/testableexamples's tests, MIT License.
package p

import (
	"fmt"
	"testing"
)

func TestHello(t *testing.T) {}

func ExampleHello() { // want "^missing output for example, go test can't validate it$"
	fmt.Println(Hello())
}

func ExampleHello_output() {
	fmt.Println(Hello())
	// Output: hello
}

func ExampleHello_unordered() {
	fmt.Println(Hello())
	// Unordered output:
	// hello
}

func ExampleHello_empty() {
	// Output:
}

func ExampleHello_notLast() { // want "missing output"
	// Output: hello
	fmt.Println(Hello())
	// done
}

func Examplehello() {
	fmt.Println(Hello())
}
