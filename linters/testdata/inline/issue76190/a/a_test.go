package a

import "testing"

func TestWithAnyName(t *testing.T) {
	F()      // not inlined
	G()      // not inlined
	print(K) // not inlined
	var _ A  // not inlined
}

