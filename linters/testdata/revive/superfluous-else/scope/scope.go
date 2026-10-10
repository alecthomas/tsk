// Adapted from github.com/mgechev/revive's tests, MIT License.

// Test data for the superfluous-else rule with preserveScope option enabled

package scope

var cond bool

func val() any { return nil }

func use(...any) {}

func fn1() {
	for {
		// No initializer, match as normal
		if cond {
			continue
		} else { // want `^superfluous-else: if block ends with a continue statement, so drop this else and outdent its block$`
			use()
		}
	}
}

func fn2() {
	for {
		// Moving the declaration of x here is fine since it goes out of scope either way
		if x := val(); x != nil {
			continue
		} else { // want `^superfluous-else: if block ends with a continue statement, so drop this else and outdent its block \(move short variable declaration to its own line if necessary\)$`
			use()
		}
	}
}

func fn3() {
	for {
		// Don't want to move the declaration of x here since it stays in scope afterward
		if x := val(); x != nil {
			continue
		} else {
			use()
		}
		x := val()
		use(x)
	}
}

func fn4() {
	for {
		if cond {
			continue
		} else {
			x := val()
			use(x)
		}
		// Don't want to move the declaration of x here since it stays in scope afterward
		y := val()
		use(y)
	}
}

func fn5() {
	for {
		if cond {
			continue
		} else { // want `^superfluous-else: if block ends with a continue statement, so drop this else and outdent its block$`
			x := val()
			use(x)
		}
		// Moving x here is fine since it goes out of scope anyway
	}
}
