// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

type A string
type B = string
type C int
type D = uintptr

func StringTest() {
	var (
		i int
		j rune
		k byte
		l C
		m D
		n = []int{0, 1, 2}
		o struct{ x int }
	)
	const p = 0
	_ = string(i) // want `^string-of-int: dubious conversion of an integer into a string, use strconv\.Itoa$`
	_ = string(j)
	_ = string(k)
	_ = string(p)    // want `^string-of-int: dubious conversion of an integer into a string, use strconv\.Itoa$`
	_ = A(l)         // want `^string-of-int: dubious conversion of an integer into a string, use strconv\.Itoa$`
	_ = B(m)         // want `^string-of-int: dubious conversion of an integer into a string, use strconv\.Itoa$`
	_ = string(n[1]) // want `^string-of-int: dubious conversion of an integer into a string, use strconv\.Itoa$`
	_ = string(o.x)  // want `^string-of-int: dubious conversion of an integer into a string, use strconv\.Itoa$`
	_ = string('x')
}
