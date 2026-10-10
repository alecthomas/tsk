// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package acceptignored tests unchecked-type-assertion accepting ignored results.
package acceptignored

var foo any = "foo"

func handleIgnoredIsOKByConfig() {
	// No lint here because `acceptIgnoredAssertionResult` is set to `true`
	r, _ := foo.(int)
	_ = r
}

func handleSkippedStillFails() {
	r := foo.(int) // want "^unchecked-type-assertion: type cast result is unchecked in foo.\\(int\\) - type assertion will panic if not matched$"
	_ = r
}
