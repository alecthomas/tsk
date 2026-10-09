package explicit

type Loose struct{ A, B int }

//exhaustruct:enforce
type Strict struct{ A, B int }

type Matched struct{ A, B int }

var (
	_ = Loose{A: 1}
	_ = Strict{A: 1}  // want `^explicit.Strict is missing field B$`
	_ = Matched{A: 1} // want `^explicit.Matched is missing field B$`
	_ = Strict{}
)
