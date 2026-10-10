package allowlist

import (
	"example.com/local"              // OK: its domain is allowed.
	"github.com/allowed/mod"         // OK
	blocked "github.com/blocked/mod" // want "^import of package `github.com/blocked/mod` is blocked because the module is not in the allowed modules list.$"
)

var _ = []int{local.X, mod.X, blocked.X}
