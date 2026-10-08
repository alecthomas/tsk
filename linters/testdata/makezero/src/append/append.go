// Adapted from github.com/ashanbrown/makezero's tests, MIT License.
package append

type (
	S []string
	M map[string]int
)

func _() {
	x := make([]int, 5)
	x = append(x, 1) // want "^append to slice `x` with non-zero initialized length$"
	_ = x
}

func _() {
	x := make(S, 10)
	x = append(x, "...") // want "append to slice `x`"
	_ = x
}

func _() {
	x := make(M, 10)
	_ = x
}

func _() {
	x := make([]int, 0)
	x = append(x, 1)
	_ = x
}

func _() {
	x := make([]int, 0, 5)
	x = append(x, 1)
	_ = x
}

func _() {
	a, b := make([]int, 1), make([]int, 0)
	a = append(a, 1) // want "append to slice `a`"
	b = append(b, 1)
	_, _ = a, b
}

func _() {
	x := make([]int, 5)
	x = append(x, 1) // nozero
	_ = x
}

func _() {
	x := make([]int, 5)
	_ = x
}

func _() {
	x := []int{}
	x = append(x, 1)
	_ = x
}
