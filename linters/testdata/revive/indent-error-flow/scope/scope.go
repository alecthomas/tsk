// Adapted from github.com/mgechev/revive's tests, MIT License.

package scope

var cond bool

func val() any { return nil }

func use(...any) {}

func fn4() {
	if cond {
		var x = val()
		use(x)
		return
	} else {
		y := val()
		use(y)
	}
	// Don't want to move the declaration of x here since it stays in scope afterward
	y := val()
	use(y)
}
