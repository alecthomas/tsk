package repeats

import "fmt"

const Existing = "existing"

const Other = "existing"

func assign() string {
	a := "repeated" // want "^string `repeated` has 4 occurrences, make it a constant$"
	b := "repeated"
	if a == "repeated" {
		return "repeated"
	}
	_ = b
	x := "existing" // want "^string `existing` has 3 occurrences, but such constant `Existing` already exists$"
	y := "existing"
	switch x {
	case "existing":
	}
	_ = y
	return ""
}

func calls() {
	// Call arguments are excluded by default.
	fmt.Println("called")
	fmt.Println("called")
	fmt.Println("called")
	// Short strings and integer strings outside min and max are ignored.
	_, _, _ = "ab", "ab", "ab"
	_, _, _ = "100", "100", "100"
}

var lookup = map[string]string{
	"key": "value", // want "^string `value` has 3 occurrences, make it a constant$"
	"other": "value",
	"third": "value",
}

var keys = map[string]int{"mapkey": 1, "mapkey2": 2} // want "^string `mapkey` has 3 occurrences, make it a constant$"
var keys2 = map[string]int{"mapkey": 1}
var keys3 = map[string]int{"mapkey": 1}
