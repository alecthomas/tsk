// Package comments is documented.
package comments

// Good ends in a period.
const Good = 1

// Bad does not end in a period // want `^Comment should end in a period$`
const Bad = 2

// Question ends in a question?
const Question = 3

// Link ends in a URL https://example.com/path
const Link = 4

// Code ends in an indented example:
//
//	x := 1
const Code = 5

//nolint:all
const Tag = 6

// TODO: excluded by pattern
const Excluded = 7

const (
	// Inside a block, but no period // want `^Comment should end in a period$`
	InBlock = 8
)

// inline comments are not declarations, so not checked by default.
func inline() {
	_ = 1 // trailing comment
}
