package options

import "fmt"

const First = "duplicate"

const Second = "duplicate" // want "^This constant is a duplicate of `First` at .*options.go:5:7$"

const Prefix = "pre"

const Joined = Prefix + "fix"

const Literal = "prefix" // want "^This constant is a duplicate of `Joined` at .*options.go:11:7$"

func calls() {
	fmt.Println("checked") // want "^string `checked` has 2 occurrences, make it a constant$"
	fmt.Println("checked")
	skip("ignored")
	skip("ignored")
	_ = 42 + 1
	_ = []int{42, 42}
}

func skip(string) {}

var m = map[string]string{"mapkey": "v", "mapkey2": "v"}

var n = map[string]string{"mapkey": "w"}
