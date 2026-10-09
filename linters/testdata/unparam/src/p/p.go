// Adapted from github.com/mvdan/unparam's tests, BSD license.
package p

import "errors"

func alwaysNil(n int) error { // want "^alwaysNil - result 0 \\(error\\) is always nil$"
	if n > 0 {
		return nil
	}
	return nil
}

func ignored(n int) (int, error) { // want "^ignored - result 0 \\(int\\) is never used$"
	if n > 0 {
		return n, nil
	}
	return 0, errors.New("x")
}

func always(n int) int { // want "^always - n always receives 3$" "^always - result 0 \\(int\\) is never used$"
	return n * 2
}

func underscore(_ int, kept int) int {
	_ = kept
	return 0
}

func Exported(a, b int) int {
	return a
}

// perPlatform is declared again in a file that build tags exclude, so its
// signature must stay as it is.
func perPlatform(n int) int {
	calls++
	return calls
}

var calls int

func panics(a int) int {
	panic("not implemented")
}

func _() {
	_, _ = ignored(1)
	_, _ = ignored(2)
	_ = always(3)
	_ = always(3)
	_ = always(3)
	_ = always(3)
	_ = underscore(1, 2)
	_ = panics(1)
	_ = perPlatform(1)
}
