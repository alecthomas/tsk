package invalid

//sumtype:decl
type NotSealed interface{ Exported() } // want `interface 'NotSealed' is not sealed`

//sumtype:decl
type NotInterface struct{} // want `type 'NotInterface' is not an interface`

//sumtype:decl
var notType int // want `//sumtype:decl must annotate a single type declaration`

//sumtype:decl
type ( // want `//sumtype:decl must annotate a single type declaration`
	first  interface{ sealed() }
	second interface{ sealed() }
)

type (
	//sumtype:decl
	Grouped interface{ sealed() } // want Grouped:`sumType \{"variants":\[\]\}`
	Plain   interface{ sealed() }
)

func local() {
	//sumtype:decl
	type Local interface{ sealed() } // want `sum type 'Local' must be declared at package level`
}
