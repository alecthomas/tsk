// Adapted from github.com/mdempsky/unconvert's tests, BSD license.
package p

type ID int

func _(n int, id ID, f float64, s string) {
	_ = int(n)       // want "^unnecessary conversion$"
	_ = ID(id)       // want "unnecessary conversion"
	_ = string(s)    // want "unnecessary conversion"
	_ = int(id)
	_ = ID(n)
	_ = int(1)
	_ = float64(f)
	_ = []byte(s)
	_ = (*int)(nil)
}
