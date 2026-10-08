// Adapted from github.com/mdempsky/unconvert's tests, BSD license.
package fast

func _(f float64, c complex128) {
	_ = float64(f)    // want "unnecessary conversion"
	_ = complex128(c) // want "unnecessary conversion"
}
