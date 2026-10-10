// Adapted from github.com/mgechev/revive's tests, MIT License.

package unreachablecode

import (
	"fmt"
	"log"
	"os"
	"testing"
)

func foo() int {
	log.Fatalf("%s", "About to fail") // ignore
	return 0                          // want `^unreachable-code: unreachable code after this statement$`
	return 1
	fmt.Println("unreachable")
	return 2
}

func f() {
	fmt.Println("Hello, playground")
	if true {
		return // want `^unreachable-code: unreachable code after this statement$`
		fmt.Println("unreachable")
		os.Exit(2) // ignore
		fmt.Println("also unreachable")
	}
	return // want `^unreachable-code: unreachable code after this statement$`
	fmt.Println("Bye, playground")
}

func g() {
	fmt.Println("Hello, playground")
	if true {
		if false {
			goto label
		}
		return // ignore if next stmt is labeled
	label:
		os.Exit(2) // ignore
	}

	fmt.Println("Bye, playground")
}

func TestA(t *testing.T) {
	tests := make([]int, 100)
	for i := range tests {
		println("i: ", i)
		if i == 0 {
			t.Fatal("i == 0") // want `^unreachable-code: unreachable code after this statement$`
			println("unreachable")
			continue
		}
		if i == 1 {
			t.Fatalf("i:%d", i) // want `^unreachable-code: unreachable code after this statement$`
			println("unreachable")
			continue
		}
		if i == 2 {
			t.FailNow() // want `^unreachable-code: unreachable code after this statement$`
			println("unreachable")
			continue
		}
	}
}
