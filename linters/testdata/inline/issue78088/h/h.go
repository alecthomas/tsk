package h

import "example.com/g"

func CallLiterals() {
	_ = g.MapLiteral[map[string]int]() // want "Call of g.MapLiteral should be inlined"
	_ = g.SliceLiteral[[]int]()        // want "Call of g.SliceLiteral should be inlined"
}

