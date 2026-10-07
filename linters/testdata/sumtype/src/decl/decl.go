package decl

//sumtype:decl
type First interface{ first() } // want First:`sumType \{"variants":\["FirstA","FirstB"\]\}`

type FirstA struct{}

func (*FirstA) first() {}

type FirstB struct{}

func (*FirstB) first() {}

//sumtype:decl
type hidden interface{ hidden() } // want hidden:`sumType \{"variants":\["HiddenA","HiddenB"\]\}`

type HiddenA struct{}

func (*HiddenA) hidden() {}

type HiddenB struct{}

func (*HiddenB) hidden() {}

// Hidden returns a value of an unexported sum type.
func Hidden() hidden { return nil }
