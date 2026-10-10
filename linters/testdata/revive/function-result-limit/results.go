// Adapted from github.com/mgechev/revive's tests, MIT License.
package results

func foo() (a, b, c, d int) { // want "^function-result-limit: maximum number of return results per function exceeded; max 3 but got 4$"
	return
}

func bar(a, b int) {

}

func baz(a string, b int) (int, int, int) {
	return 0, 0, 0
}

func qux() (string, string, int, string, int) { // want "^function-result-limit: maximum number of return results per function exceeded; max 3 but got 5$"
	return "", "", 0, "", 0
}
