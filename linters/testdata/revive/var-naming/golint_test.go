// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package pkg_with_underscores ...
package pkg_test

import "testing"

var var_name int // want "^var-naming: don't use underscores in Go names; var var_name should be varName$"

func Test_ATest(*testing.T)           {}
func Example_AnExample()              {}
func Benchmark_ABenchmark(*testing.B) {}

func Fuzz_AFuzz(*testing.F) {}
