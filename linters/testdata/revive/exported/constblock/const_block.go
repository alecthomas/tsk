// Adapted from github.com/mgechev/revive's tests, MIT License.

// Test for docs in const blocks

// Package foo ...
package foo

const (
	InlineComment = "ShouldBeOK" // InlineComment is not a valid documentation // want `^exported: exported const InlineComment should have comment \(or a comment on this block\) or be unexported$`

	// want `^exported: comment on exported const InlineWhatever should be of the form "InlineWhatever ..."$`
	InlineWhatever = "blah"

	Whatsit = "missing_comment"

	// We should only warn once per block for missing comments,
	// thus do not warn on Whatsit,
	// but always complain about malformed comments.

	WhosYourDaddy = "another_missing_one"

	// Something // want `^exported: comment on exported const WhatDoesHeDo should be of the form "WhatDoesHeDo ..."$`
	WhatDoesHeDo = "it's not a tumor!"
)

// These shouldn't need doc comments.
const (
	Alpha = "a"
	Beta  = "b"
	Gamma = "g"
)

// The comment on the previous const block shouldn't flow through to here.

const UndocAgain = 6 // want "^exported: exported const UndocAgain should have comment or be unexported$"

const (
	SomeUndocumented = 7 // want `^exported: exported const SomeUndocumented should have comment \(or a comment on this block\) or be unexported$`
)
