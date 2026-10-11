// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package golint comment
package golint

// path separator defined by os.Separator.
const FilePath = "xyz"

// Rewrite string to remove non-standard path characters
func UnicodeSanitize(s string) string { return s }

// Tags returns a slice of tags. The order is the original tag order unless it
// was changed.
func (t *Tags) Keys() []string { return nil }

// A value which may be passed to the which parameter for Getitimer and
type ItimerWhich int

// toolchain var incorrect
var ToolchainRE = "toolchain"

/*
// PropertyBag
*/
// Rectangle An area within an image.
type Rectangle struct{}

type Tags []string
