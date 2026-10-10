// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package blankimports tests blank-imports.
package blankimports

// Expectations are leading block comments, because a trailing comment
// would justify the import.
import (
	/* want "^blank-imports: a blank import should be only in a main or test package, or have a comment justifying it$" */ _ "embed"
	"fmt"

	/* want "^blank-imports: a blank import should be only in a main or test package, or have a comment justifying it$" */ _ "net/http/pprof"
	_ "os"

	// Justified.
	_ "strings"
	_ "unicode" // Justified.
)

var _ = fmt.Sprint
