// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package golint comment
package golint

// Test cases for enabling checks of exported methods of private types in exported rule
type private struct {
}

// want `^exported: comment on exported method private.Method should be of the form "Method ..."$`
func (p *private) Method() {
}
