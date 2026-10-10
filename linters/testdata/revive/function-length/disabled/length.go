// Package disabled tests function-length with both limits off.
package disabled

func long(x int) {
	if x > 0 {
		println()
		println()
		println()
	}
	for range x {
		println()
		println()
	}
}
