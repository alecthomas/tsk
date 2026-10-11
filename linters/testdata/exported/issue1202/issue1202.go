// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package golint comment
package golint

import (
	_ "embed"
)

var A []byte // want "^exported var A should have comment or be unexported$"

var B string // want "^exported var B should have comment or be unexported$"

//go:embed foo.txt
var C []byte // want "^exported var C should have comment or be unexported$"

//go:generate pwd
var D string // want "^exported var D should have comment or be unexported$"

func E() string { // want "^exported function E should have comment or be unexported$"
	return "E"
}

//nolint:gochecknoglobals
func F() string { // want "^exported function F should have comment or be unexported$"
	return "F"
}

//nolint:gochecknoglobals
const G = "G" // want "^exported const G should have comment or be unexported$"
