package loops

func forLoop(n int) []int {
	var out []int // want `^Consider preallocating out with capacity n$`
	for i := 0; i < n; i++ {
		out = append(out, i)
	}
	return out
}

func stepped(lo, hi int) []int {
	var out []int // want `^Consider preallocating out with capacity \(hi-lo\)/2 \+ 1$`
	for i := lo; i < hi; i += 2 {
		out = append(out, i)
	}
	return out
}

func early(xs []int) []int {
	var out []int // want `^Consider preallocating out with capacity len\(xs\)$`
	for _, x := range xs {
		if x < 0 {
			continue
		}
		out = append(out, x)
	}
	return out
}
