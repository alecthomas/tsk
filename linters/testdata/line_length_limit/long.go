// Package linelengthlimit tests line-length-limit.
package linelengthlimit

var short = 1

// Lengths include the expectation comments.
var long = "long" // want "^line is 68 characters, out of limit 60$"

// Excluded lines may be long: https://example.com/a/very/long/url/to/somewhere
func f() {
	_ = short + len(long) // want "^line is 76 characters, out of limit 60$"
}

//nolint:line_length_limit // The declaration below is too long.
var skipped = "a line that is longer than sixty characters, but disabled"
