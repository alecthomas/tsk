package b

import (
	"strings"
	"example.com/a"
)

func _() {
    var buf strings.Builder
	// The inliner wants to add an import for "io"; make sure post-processing of the fix removes it.
	a.OldHello(&buf) // want "Call of a.OldHello should be inlined"
}

