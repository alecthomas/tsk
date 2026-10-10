// Adapted from github.com/mgechev/revive's tests, MIT License.

// Test data for the early-return rule with allowJump option enabled

package jumpscope

import (
	"os"
)

var cond bool

func a() bool { return false }

func fn2() {}

func fn1() {
	if cond { // want `^early-return: if c \{ \.\.\. \} can be rewritten if !c \{ return \} \.\.\. to reduce nesting$`
		println()
		println()
		println()
	}
}

func fn3() {
	if a() {
		println()
		os.Exit(1)
	}
}

func fn4() {
	// No initializer, match as normal
	if cond { // want `^early-return: if c \{ \.\.\. \} else \{ \.\.\. return \} can be simplified to if !c \{ \.\.\. return \} \.\.\.$`
		fn2()
	} else {
		return
	}
}
