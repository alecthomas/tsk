// Adapted from github.com/mgechev/revive's tests, MIT License.

// Test of empty-blocks.

package earlyreturn

import "os"

var cond bool

func foo() (int, bool) { return 0, false }

func earlyRet() bool {
	if cond { // want `^early-return: if c \{ \.\.\. \} else \{ \.\.\. return \} can be simplified to if !c \{ \.\.\. return \} \.\.\.$`
		println()
		println()
		println()
	} else {
		return false
	}

	if cond { // want `^early-return: if c \{ \.\.\. \} else \{ \.\.\. return \} can be simplified to if !c \{ \.\.\. return \} \.\.\.$`
		println()
	} else {
		return false
	}

	if cond { // want `^early-return: if c \{ \} else \{ \.\.\. return \} can be simplified to if !c \{ \.\.\. return \}$`
	} else {
		return false
	}

	if cond {
		println()
	} else if cond { // want `^early-return: if c \{ \} else \{ \.\.\. return \} can be simplified to if !c \{ \.\.\. return \}$`
	} else {
		return false
	}

	// the first branch does not return, so we can't reduce nesting here
	if cond {
		println()
	} else if cond {
		println()
	} else {
		return false
	}

	// Case already covered by golint
	if cond {
		return true
	} else {
		return false
	}

	if cond { // want `^early-return: if c \{ \.\.\. \} else \{ \.\.\. return \} can be simplified to if !c \{ \.\.\. return \} \.\.\.$`
		println()
		println()
		println()
	} else {
		return false
	}

	if cond {
		println()
		println()
		println()
	} else {
		println()
	}

	if cond {
		if cond { // want `^early-return: if c \{ \.\.\. \} else \{ \.\.\. return \} can be simplified to if !c \{ \.\.\. return \} \.\.\.$`
			println()
		} else {
			return false
		}
	}

	if cond {
		println()
	} else {
		if cond { // want `^early-return: if c \{ \.\.\. \} else \{ \.\.\. return \} can be simplified to if !c \{ \.\.\. return \} \.\.\.$`
			println()
		} else {
			return false
		}
	}

	if cond {
		println()
	} else if cond {
		println()
	} else {
		if cond { // want `^early-return: if c \{ \.\.\. \} else \{ \.\.\. return \} can be simplified to if !c \{ \.\.\. return \} \.\.\.$`
			println()
		} else {
			return false
		}
	}

	for {
		if cond { // want `^early-return: if c \{ \.\.\. \} else \{ \.\.\. continue \} can be simplified to if !c \{ \.\.\. continue \} \.\.\.$`
			println()
		} else {
			continue
		}
	}

	for {
		if cond { // want `^early-return: if c \{ \.\.\. \} else \{ \.\.\. break \} can be simplified to if !c \{ \.\.\. break \} \.\.\.$`
			println()
		} else {
			break
		}
	}

	if cond { // want `^early-return: if c \{ \.\.\. \} else \{ \.\.\. panic\(\) \} can be simplified to if !c \{ \.\.\. panic\(\) \} \.\.\.$`
		println()
	} else {
		panic("!")
	}

	if cond { // want `^early-return: if c \{ \.\.\. \} else \{ \.\.\. goto \} can be simplified to if !c \{ \.\.\. goto \} \.\.\.$`
		println()
	} else {
		goto X
	}

	if x, ok := foo(); ok { // want `^early-return: if c \{ \.\.\. \} else \{ \.\.\. return \} can be simplified to if !c \{ \.\.\. return \} \.\.\. \(move short variable declaration to its own line if necessary\)$`
		println(x)
	} else {
		return false
	}

	if cond { // want `^early-return: if c \{ \.\.\. \} else \{ \.\.\. os\.Exit\(\) \} can be simplified to if !c \{ \.\.\. os\.Exit\(\) \} \.\.\.$`
		println()
	} else {
		os.Exit(0)
	}

X:
	for {
		// inversion is not suggested here without allowJump option enabled
		if cond {
			println()
			println()
			println()
		}
	}
}
