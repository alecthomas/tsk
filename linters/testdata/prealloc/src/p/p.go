package p

func rangeSlice(xs []int) []int {
	var out []int // want `^Consider preallocating out with capacity len\(xs\)$`
	for _, x := range xs {
		out = append(out, x)
	}
	return out
}

func twice(xs []int) []int {
	out := []int{} // want `^Consider preallocating out with capacity 2 \* len\(xs\)$`
	for _, x := range xs {
		out = append(out, x, x)
	}
	return out
}

func early(xs []int) []int {
	var out []int
	for _, x := range xs {
		if x < 0 {
			return nil
		}
		out = append(out, x)
	}
	return out
}

func forLoop(n int) []int {
	var out []int
	for i := 0; i < n; i++ {
		out = append(out, i)
	}
	return out
}
