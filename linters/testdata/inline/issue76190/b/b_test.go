package b_test

import (
	"example.com/a"
	"testing"
)

func TestF(t *testing.T) {
	a.F() // want "Call of a.F should be inlined"
}

