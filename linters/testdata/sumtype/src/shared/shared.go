package shared

//sumtype:decl
type T1 interface{ sealed1() } // want T1:`sumType \{"variants":\["A","B","C"\]\}`

type T2 interface {
	T1
	sealed2()
}

type A struct{}

func (*A) sealed1() {}

type B struct{}

func (*B) sealed1() {}
func (*B) sealed2() {}

type C struct{}

func (*C) sealed1() {}
func (*C) sealed2() {}

func sharedInterface(t T1) {
	switch t.(type) {
	case *A:
	case T2:
	}
}

func missingLeaf(t T1) {
	switch t.(type) { // want `missing cases for A$`
	case T2:
	}
}
