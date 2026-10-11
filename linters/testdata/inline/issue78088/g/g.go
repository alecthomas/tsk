package g

//go:fix inline
func MapLiteral[T ~map[string]int]() T { // want MapLiteral:`goFixInline {"name":"g.MapLiteral"`
	return T{"k": 1}
}

//go:fix inline
func SliceLiteral[T ~[]int]() T { // want SliceLiteral:`goFixInline {"name":"g.SliceLiteral"`
	return T{1, 2, 3}
}

