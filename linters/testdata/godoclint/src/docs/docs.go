// Adapted from github.com/godoc-lint/godoc-lint's tests, MIT License.

// The docs package is badly documented. // want `^package godoc should start with "Package docs "$` `^package has more than one godoc \("docs"\)$`
package docs

// Good is documented properly.
const Good = 1

// Returns the answer. // want `^godoc should start with symbol name \("Answer"\)$`
func Answer() int { return 42 }

// An Article may start the doc.
type Article struct{}

// The Thing also.
type Thing struct{}

// DEPRECATED: use Good. // want `^deprecation note should be formatted as "Deprecated: "$` `^godoc should start with symbol name \("Old"\)$`
const Old = 2

// Older is retired.
//
// Deprecated: use Good.
const Older = 3

// Wrong start, but deprecated docs are exempt.
//
// Deprecated: use Good.
const Retired = 4

// unexported docs are not checked.
func helper() {}

// Linked refers to [Go] and has an unused [link]. // want `^godoc has unused link \("unused"\)$`
//
// [Go]: https://go.dev
// [unused]: https://example.com
func Linked() {}

//godoclint:disable start-with-name
// Disabled has a directive.
func Disabled() {}
