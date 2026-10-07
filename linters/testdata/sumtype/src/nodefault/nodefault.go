package nodefault

//sumtype:decl
type T interface{ sealed() } // want T:`sumType \{"variants":\["A","B"\]\}`

type A struct{}

func (*A) sealed() {}

type B struct{}

func (*B) sealed() {}

func defaultCase(t T) {
	switch t.(type) { // want `missing cases for B$`
	case *A:
	default:
	}
}
