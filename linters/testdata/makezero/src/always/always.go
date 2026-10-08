// Adapted from github.com/ashanbrown/makezero's tests, MIT License.
package always

type S []string

func _() {
	x := make([]int, 5) // want "^slice `x` does not have non-zero initial length$"
	_ = x
}

func _() {
	x := make(S, 10)     // want "slice `x` does not have non-zero initial length"
	x = append(x, "...") // want "append to slice `x` with non-zero initialized length"
	_ = x
}

func _() {
	x := make([]int, 5) // nozero
	_ = x
}

func _() {
	x := make([]int, 0)
	_ = x
}

func _() {
	var s struct{ f []int }
	s.f = make([]int, 2) // want "slice `s.f` does not have non-zero initial length"
	s.f = append(s.f, 1)
}
