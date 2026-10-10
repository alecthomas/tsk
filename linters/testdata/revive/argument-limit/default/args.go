// Adapted from github.com/mgechev/revive's tests, MIT License.
package argsdefault

func foo(a, b, c, d, e, f, g, h int) {
}

func bar(a, b, c, d, e, f, g, h, i int64) { // want "^argument-limit: maximum number of arguments per function exceeded; max 8 but got 9$"
}
