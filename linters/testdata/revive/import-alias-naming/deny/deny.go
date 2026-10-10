// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

import (
	magical "magic/hat"
	_ "strings"
	bar_foo "strings"
	fooBAR "strings"
	v1 "strings" // want `^import-alias-naming: import name \(v1\) must NOT match the regular expression: \^\(\(v\\d\+\)\|\(v\\d\+alpha\\d\+\)\)\$$`
	v1alpha1 "strings" // want `^import-alias-naming: import name \(v1alpha1\) must NOT match the regular expression: \^\(\(v\\d\+\)\|\(v\\d\+alpha\\d\+\)\)\$$`
)

func somefunc() {
	fooBAR.Clone("")
	bar_foo.Clone("")
	v1.Clone("")
	magical.Clone("")
}
