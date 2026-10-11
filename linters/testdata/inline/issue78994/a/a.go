package a

type Val int

//go:fix inline
type Value = Val // want Value:"goFixInline alias"

func f(Value) Value { return 1 } // want "Type alias Value should be inlined" "Type alias Value should be inlined"

var x []Value // want "Type alias Value should be inlined"

