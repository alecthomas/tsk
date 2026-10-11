// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

import (
	magical "magic/hat"
	_ "strings"
	bar_foo "strings" // want `^import name \(bar_foo\) must match the regular expression: \^\[a-z\]\+\$$`
	fooBAR "strings" // want `^import name \(fooBAR\) must match the regular expression: \^\[a-z\]\+\$$`
	v1 "strings" // want `^import name \(v1\) must match the regular expression: \^\[a-z\]\+\$$`
)

func somefunc() {
	fooBAR.Clone("")
	bar_foo.Clone("")
	v1.Clone("")
	magical.Clone("")
}
