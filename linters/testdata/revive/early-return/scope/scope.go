// Adapted from github.com/mgechev/revive's tests, MIT License.

// Test data for the early-return rule with preserveScope option enabled

package scope

var cond bool

func val() any { return nil }

func use(...any) {}

func fn1() {
	// No initializer, match as normal
	if cond { // want `^early-return: if c \{ \.\.\. \} else \{ \.\.\. return \} can be simplified to if !c \{ \.\.\. return \} \.\.\.$`
		use()
	} else {
		return
	}
}

func fn2() {
	// Moving the declaration of x here is fine since it goes out of scope either way
	if x := val(); x != nil { // want `^early-return: if c \{ \.\.\. \} else \{ \.\.\. return \} can be simplified to if !c \{ \.\.\. return \} \.\.\. \(move short variable declaration to its own line if necessary\)$`
		use()
	} else {
		return
	}
}

func fn3() {
	// Don't want to move the declaration of x here since it stays in scope afterward
	if x := val(); x != nil {
		use()
	} else {
		return
	}
	x := val()
	use(x)
}

func fn4() {
	if cond {
		var x = val()
		use(x)
	} else {
		return
	}
	// Don't want to move the declaration of x here since it stays in scope afterward
	y := val()
	use(y)
}

func fn5() {
	if cond {
		x := val()
		use(x)
	} else {
		return
	}
	// Don't want to move the declaration of x here since it stays in scope afterward
	y := val()
	use(y)
}

func fn6() {
	if cond { // want `^early-return: if c \{ \.\.\. \} else \{ \.\.\. return \} can be simplified to if !c \{ \.\.\. return \} \.\.\.$`
		x := val()
		use(x)
	} else {
		return
	}
	// Moving x here is fine since it goes out of scope anyway
}
