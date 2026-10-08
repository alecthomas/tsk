package defaults

import (
	"fmt"
	"testing"
)

func ExamplePrint() {
	fmt.Println("examples may print")
	// Output: examples may print
}

func TestPrint(t *testing.T) {
	fmt.Println("tests may not") // want "use of `fmt.Println` forbidden"
}
