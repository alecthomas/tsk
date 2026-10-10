// Package linelengthlimit tests line-length-limit.
package linelengthlimit

var short = 1

// Lengths include the expectation comments.
var long = "long" // want "^line-length-limit: line is 87 characters, out of limit 60$"

// Excluded lines may be long: https://example.com/a/very/long/url/to/somewhere
func f() {
	_ = short + len(long) // want "^line-length-limit: line is 95 characters, out of limit 60$"
}

// revive:disable-next-line:line-length-limit
var skipped = "a line that is longer than sixty characters, but disabled"
