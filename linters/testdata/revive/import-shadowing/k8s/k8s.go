// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

import (
	"k8s.io/api/core/v1" // package name is v1
)

func testVer() {
	v1 := "" // Do not warn on this rare case.
	core := "" // want "^import-shadowing: The name 'core' shadows an import name$"
}
