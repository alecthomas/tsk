// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package modifiesparameter tests modifies-parameter.
package modifiesparameter

import "slices"

func one(a int) {
	a, b := 1, 2 // want "^modifies-parameter: parameter 'a' seems to be modified$"
	a++          // want "^modifies-parameter: parameter 'a' seems to be modified$"
	_ = b
}

func two(b, c float32) {
	if c > 0.0 {
		b = 1 // want "^modifies-parameter: parameter 'b' seems to be modified$"
	}
}

type foo struct {
	a string
}

func three(s *foo) {
	s.a = "foooooo"
}

// non regression test for issue 355
func issue355(_ *foo) {
	_ = "foooooo"
}

func testSlicesDeleteAssigned(s []int) {
	s = slices.Delete(s, 0, 1)                                 // want "^modifies-parameter: parameter 's' seems to be modified by 'slices.Delete'$" "^modifies-parameter: parameter 's' seems to be modified$"
	s = slices.DeleteFunc(s, func(e int) bool { return true }) // want "^modifies-parameter: parameter 's' seems to be modified by 'slices.DeleteFunc'$" "^modifies-parameter: parameter 's' seems to be modified$"
	_ = slices.Delete(s, 0, 1)                                 // want "^modifies-parameter: parameter 's' seems to be modified by 'slices.Delete'$"
	_ = slices.DeleteFunc(s, func(e int) bool { // want "^modifies-parameter: parameter 's' seems to be modified by 'slices.DeleteFunc'$"
		return true
	})
	s, b := slices.Delete(s, 0, 1), 2 // want "^modifies-parameter: parameter 's' seems to be modified by 'slices.Delete'$" "^modifies-parameter: parameter 's' seems to be modified$"
	_ = b
	s = slices.Clone(s) // want "^modifies-parameter: parameter 's' seems to be modified$"
}

func testSlicesDeleteCloned(s []int) {
	s2 := slices.Clone(s)
	s2 = slices.Delete(s2, 0, 1)
	_ = slices.Delete(slices.Clone(s), 0, 1)
	_ = slices.DeleteFunc(slices.Clone(s), func(e int) bool {
		return e == 0
	})
}

func testSlicesDeleteCopied(s []int) {
	c := make([]int, len(s))
	copy(c, s)
	c = slices.Delete(c, 0, 1)
}

func testMultipleParams(a, b, s []int) {
	a = slices.Delete(a, 0, 1) // want "^modifies-parameter: parameter 'a' seems to be modified by 'slices.Delete'$" "^modifies-parameter: parameter 'a' seems to be modified$"
	b = slices.Delete(b, 1, 2) // want "^modifies-parameter: parameter 'b' seems to be modified by 'slices.Delete'$" "^modifies-parameter: parameter 'b' seems to be modified$"
	s = []int{1, 2, 3}         // want "^modifies-parameter: parameter 's' seems to be modified$"
	s = slices.Delete(s, 0, 1) // want "^modifies-parameter: parameter 's' seems to be modified by 'slices.Delete'$" "^modifies-parameter: parameter 's' seems to be modified$"
}

func testAssignToNewVar(s []int) {
	newSlice := s
	newSlice = slices.Delete(newSlice, 0, 1)
}

func testExprStmt(s []int) {
	slices.Delete(s, 0, 1) // want "^modifies-parameter: parameter 's' seems to be modified by 'slices.Delete'$"
}
