// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package uncheckedtypeassertion tests unchecked-type-assertion.
package uncheckedtypeassertion

import "fmt"

var (
	foo  any = "foo"
	bar  any = 1
	bars     = []any{1, 42, "some", "thing"}
)

func handleIgnored() {
	r, _ := foo.(int) // want "^unchecked-type-assertion: type cast result is unchecked in foo.\\(int\\) - type assertion result ignored$"
	_ = r
}

func handleSkipped() {
	r := foo.(int) // want "^unchecked-type-assertion: type cast result is unchecked in foo.\\(int\\) - type assertion will panic if not matched$"
	_ = r
}

func handleReturn() int {
	return foo.(int) // want "^unchecked-type-assertion: type cast result is unchecked in foo.\\(int\\) - type assertion will panic if not matched$"
}

func handleSwitch() {
	switch foo.(int) { // want "^unchecked-type-assertion: type cast result is unchecked in foo.\\(int\\) - type assertion will panic if not matched$"
	case 0:
	case 1:
		//
	}
}

func handleRange() {
	var some any = bars
	for _, x := range some.([]string) { // want "^unchecked-type-assertion: type cast result is unchecked in some.\\(\\[\\]string\\) - type assertion will panic if not matched$"
		fmt.Println(x)
	}
}

func handleTypeSwitch() {
	// Should not be a lint
	switch foo.(type) {
	case string:
	case int:
		//
	}
}

func handleTypeSwitchWithAssignment() {
	// Should not be a lint
	switch n := foo.(type) {
	case string:
	case int:
		_ = n
	}
}

func handleTypeComparison() {
	if foo.(int) == 1 { // want "^unchecked-type-assertion: type cast result is unchecked in foo.\\(int\\) - type assertion will panic if not matched$"
		return
	}
}

func handleTypeComparisonReverse() {
	if 1 == foo.(int) { // want "^unchecked-type-assertion: type cast result is unchecked in foo.\\(int\\) - type assertion will panic if not matched$"
		return
	}
}

func handleTypeAssignmentComparison() {
	var value any
	value = 42 // int

	if v := value.(int); v == 42 { // want "^unchecked-type-assertion: type cast result is unchecked in value.\\(int\\) - type assertion will panic if not matched$"
		fmt.Printf("Value is an integer: %d\n", v)
	}
}

func handleSwitchComparison() {
	switch foo.(int) == 1 { // want "^unchecked-type-assertion: type cast result is unchecked in foo.\\(int\\) - type assertion will panic if not matched$"
	case true:
	case false:
	}
}

func handleSwitchComparisonReverse() {
	switch 1 == foo.(int) { // want "^unchecked-type-assertion: type cast result is unchecked in foo.\\(int\\) - type assertion will panic if not matched$"
	case true:
	case false:
	}
}

func handleInnerSwitchAssertion() {
	switch {
	case foo.(int) == 1: // want "^unchecked-type-assertion: type cast result is unchecked in foo.\\(int\\) - type assertion will panic if not matched$"
	case bar.(int) == 1: // want "^unchecked-type-assertion: type cast result is unchecked in bar.\\(int\\) - type assertion will panic if not matched$"
	}
}

func handleInnerSwitchAssertionReverse() {
	switch {
	case 1 == foo.(int): // want "^unchecked-type-assertion: type cast result is unchecked in foo.\\(int\\) - type assertion will panic if not matched$"
	case 1 == bar.(int): // want "^unchecked-type-assertion: type cast result is unchecked in bar.\\(int\\) - type assertion will panic if not matched$"
	}
}

func handleChannelWrite() {
	c := make(chan any)
	var a any = "foo"
	c <- a.(int) // want "^unchecked-type-assertion: type cast result is unchecked in a.\\(int\\) - type assertion will panic if not matched$"
}
