// Adapted from github.com/mgechev/revive's tests, MIT License.
package max3

func foo(a, b, c, d int) { // want "^argument-limit: maximum number of arguments per function exceeded; max 3 but got 4$"

}

func bar(a, b int) {

}

func baz(a string, b int) {

}

func qux(a string, b int, c int, d string, e int64) { // want "^argument-limit: maximum number of arguments per function exceeded; max 3 but got 5$"

}

// Unnamed parameters do not count.
func unnamed(string, int, int, string, int64) {}

type T struct{}

func (t T) method(a, b, c, d int) { // want "^argument-limit: maximum number of arguments per function exceeded; max 3 but got 4$"
}
