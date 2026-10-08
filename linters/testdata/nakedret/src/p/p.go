// Adapted from github.com/alexkohler/nakedret's tests, MIT License.
package p

func long() (a, b int) {
	a = 1
	b = 2
	return // want "^naked return in func `long` with 4 lines of code$"
}

func short() (a int) {
	return
}

func unnamed() int {
	return 0
}

func explicit() (a int) {
	a = 1
	a++
	a++
	return a
}

func nested() {
	_ = func() (err error) {
		err = nil
		_ = err
		return // want "^naked return in func `nested.<func\\(\\):26>` with 4 lines of code$"
	}
}
