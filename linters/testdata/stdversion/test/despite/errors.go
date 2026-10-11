// File version is 1.21.

// Check that RunDespiteErrors is enabled.
package ignore

import "go/types"

func _() {
	// report something before the syntax error.
	_ = new(types.Info).FileVersions // want `types.Info.FileVersions requires go1.22 or later \(module is go1.21\)`
}

invalid syntax // exercise RunDespiteErrors

