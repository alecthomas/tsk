// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

import (
	"fmt"
)

type useFmtPrintT struct{}

func (useFmtPrintT) print(s string)   {}
func (useFmtPrintT) println(s string) {}

func useFmtPrint(something, some, thing int) {
	fmt.Println("just testing")
	fmt.Print("just testing")
	t := useFmtPrintT{}
	t.print("just testing")
	t.println("just testing")

	println("just testing", something)   // want `^use-fmt-print: avoid using built-in function "println", replace it by "fmt\.Fprintln\(os\.Stderr, "just testing", something\)"$`
	print("just testing", some, thing+1) // want `^use-fmt-print: avoid using built-in function "print", replace it by "fmt\.Fprint\(os\.Stderr, "just testing", some, thing \+ 1\)"$`
	fmt.Println(func() int { println(); return 0 }())
	_ = func() int { println(); return 0 } // want `^use-fmt-print: avoid using built-in function "println", replace it by "fmt\.Fprintln\(os\.Stderr, \)"$`
}
