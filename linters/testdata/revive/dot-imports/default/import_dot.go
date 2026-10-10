// Adapted from github.com/mgechev/revive's tests, MIT License.

// Test that dot imports are flagged.

// Package fixtures ...
package fixtures

import . "fmt" // want `^dot-imports: should not use dot imports$`

var _ Stringer // from "fmt"
