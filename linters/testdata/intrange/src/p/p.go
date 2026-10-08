// Adapted from github.com/ckaznocha/intrange's tests, MIT License.
package p

func count() int { return 3 }

func _(n int, s []int) {
	for i := 0; i < 10; i++ { // want `^for loop can be changed to use an integer range \(Go 1\.22\+\)$`
		print(i)
	}

	for i := 0; i <= 10; i += 1 { // want `integer range`
	}

	for i := 0; n > i; i = i + 1 { // want `integer range`
	}

	for i := 0; i < len(s); i++ { // want `integer range`
	}

	for i := 0; i < count(); i++ { // want `returned by a function or method`
	}

	var i int
	for i = 0; i < n; i++ { // want `not part of the loop's scope`
	}

	for i := 0; i <= n; i++ {
	}

	for i := 1; i < n; i++ {
	}

	for i := 0; i < n; i += 2 {
	}

	for i := 0; i < n; i++ {
		i++
	}

	for i := 0; i < n; i++ {
		n--
	}

	for i := range len(s) { // want "^for loop can be changed to `i := range s`$"
		print(i)
	}

	for range len(s) { // want "^for loop can be changed to `range s`$"
	}

	for range len("abc") {
	}
}
