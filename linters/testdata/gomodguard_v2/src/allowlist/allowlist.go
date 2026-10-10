package allowlist

import (
	"example.com/local"              // OK: allowed by prefix.
	"github.com/allowed/mod"         // OK: allowed by regular expression.
	blocked "github.com/blocked/mod" // want "^import of package `github.com/blocked/mod` is blocked because the module is not in the allowed modules list.$"
	old "github.com/old/mod"         // want "^import of package `github.com/old/mod` is blocked because version `v0.9.0` does not meet the allowed version constraint `>=1`.$"
)

var _ = []int{local.X, mod.X, blocked.X, old.X}
