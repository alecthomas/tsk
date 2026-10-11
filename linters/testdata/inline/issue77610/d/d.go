package d

import (
	"time"

	"example.com/c"
)

func _() {
	t := time.Now()
	// The inliner wants to add an import for "encoding/json"; make sure post-processing of the fix removes it.
	c.OldProcess(t) // want "Call of c.OldProcess should be inlined"
}

