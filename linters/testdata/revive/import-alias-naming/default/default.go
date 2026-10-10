// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

import (
	. "dotimport" // . aliases should be ignored
	magical "magic/hat"
	_ "strings"       // _ aliases should be ignored
	bar_foo "strings" // want `^import-alias-naming: import name \(bar_foo\) must match the regular expression: \^\[a-z\]\[a-z0-9\]\{0,\}\$$`
	fooBAR "strings" // want `^import-alias-naming: import name \(fooBAR\) must match the regular expression: \^\[a-z\]\[a-z0-9\]\{0,\}\$$`
	v1 "strings"
)

func somefunc() {
	fooBAR.Clone("")
	bar_foo.Clone("")
	v1.Clone("")
	magical.Clone("")
}
