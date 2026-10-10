// Adapted from github.com/mgechev/revive's tests, MIT License.
package constantdefault

func foo(a, b, c, d, e string, f int) {
	a = "ignore"
	b = "ignore"

	c = "match"
	d = "match"
	e = "match" // want "^add-constant: string literal \"match\" appears, at least, 3 times, create a named constant for it$"

	f = 5 // want "^add-constant: avoid magic numbers like '5', create a named constant for it$"

	_ = ""
	_ = ""
	_ = ""
	_ = ``
	_ = ``
	_ = ``

	// Declarations are skipped.
	const g = 7
	var h = 8
	_ = h
}
