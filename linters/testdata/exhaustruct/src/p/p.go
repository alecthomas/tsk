package p

import "errors"

type T struct {
	A int
	B string
	//exhaustruct:optional
	C bool
	_ int
}

func literals() {
	_ = T{A: 1, B: "b"}
	_ = T{A: 1} // want `^p.T is missing field B$`
	_ = T{}     // want `^p.T is missing fields A, B$`
	_ = &T{A: 1, B: "b", C: true}
	_ = []T{{A: 1}} // want `^p.T is missing field B$`
	_ = struct{ X, Y int }{X: 1} // want `^p.<anonymous> is missing field Y$`
}

func returnsError() (T, error) {
	return T{}, errors.New("failed")
}

func ignored() {
	//exhaustruct:ignore
	_ = T{}
}

//exhaustruct:ignore
type Skipped struct{ A, B int }

var _ = Skipped{}

/*exhaustruct:bogus*/ var _ = 1 // want `^unknown directive \(directive=bogus\)$`
