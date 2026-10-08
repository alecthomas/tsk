package enums

type Direction int // want Direction:`"names":\["North","East","South","West","unexported"\]`

const (
	North Direction = iota
	East
	South
	West
	unexported
)

// Aliased members share a value, so either one covers it.
type Shape string // want Shape:`"names":\["Circle","Round","Square"\]`

const (
	Circle Shape = "circle"
	Round  Shape = "circle"
	Square Shape = "square"
)

type Level int // want Level:`"names":\["Low","High"\]`

const (
	Low Level = iota + 10
	High
)

//exhaustive:ignore
type Ignored int

const (
	IgnoredA Ignored = iota
	IgnoredB
)
