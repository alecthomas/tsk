//go:build go1.21

package basic

// Before Go 1.22, loop variables are shared between iterations, so copies matter.
func oldLoops() {
	for i := range []int{1, 2, 3} {
		i := i
		_ = i
	}
}
