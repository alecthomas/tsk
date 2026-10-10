package app

import (
	"example.com/elsewhere"          // want "^import of package `example.com/elsewhere` is blocked because the module has a local replace directive.$"
	"example.com/local"              // OK: the directory holds the module.
	"github.com/allowed/mod"         // OK
	blocked "github.com/blocked/mod" // want "^import of package `github.com/blocked/mod` is blocked because the module is in the blocked modules list. `example.com/a` and `example.com/b` are recommended modules. Deprecated.$"
	old "github.com/old/mod"         // want "^import of package `github.com/old/mod` is blocked because the module is in the blocked modules list. version `v0.9.0` is blocked because it does not meet the version constraint `<1`. Too old.$"
)

var _ = []int{elsewhere.X, local.X, mod.X, blocked.X, old.X}
