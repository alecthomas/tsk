// Adapted from github.com/mgechev/revive's tests, MIT License.
package flag

type mystruct struct {
	a bool
	b int
}

func fooFlagP(a bool, b int) { // want "^flag-parameter: parameter 'a' seems to be a control flag, avoid control coupling$"
	if a {

	}
}

func barFlagP(a bool, b int) {
	str := mystruct{a, b}
	_ = str
}

// issue #1211
func bazFlagP(a int, b bool) {
	lBool := true
	if lBool {
		// do something
	}
}

func twice(a, b bool) { // want "^flag-parameter: parameter 'b' seems to be a control flag, avoid control coupling$" "^flag-parameter: parameter 'a' seems to be a control flag, avoid control coupling$"
	if b && a {
		if a {
		}
	}
	if a {
	}
}
