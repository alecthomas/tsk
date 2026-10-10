// Adapted from github.com/mgechev/revive's tests, MIT License.

package commentspacings

import (
	"fmt"
	"os"
)

//revive:disable:cyclomatic
type some struct{}

//revive:disable:cyclomatic High complexity score but easy to understand
type some1 struct{}

// Some nice comment
//
// With an empty line in the middle will make the rule panic!
func itsATrap() {}

// This is a well formed comment
type hello struct {
	Random string `json:"random"`
}

//This comment does not respect the spacing rule! // want "^comment-spacings: no space between comment delimiter and comment text$"
var a string

/*
Should be valid
*/

//	Tabs between comment delimiter and comment text should be fine

/*Not valid // want "^comment-spacings: no space between comment delimiter and comment text$"
 */

/*	valid
 */

/* valid
 */

//nolint:staticcheck // nolint should be in the default list of acceptable comments.
var b string

//extern open
//export MyFunction

//nolint:gochecknoglobals

//this is a regular command that's incorrectly formatted //nolint:foobar // because one two three // want "^comment-spacings: no space between comment delimiter and comment text$"

//myOwnDirective: is not allowed by default // want "^comment-spacings: no space between comment delimiter and comment text$"

//go:generate pwd

func _(outputPath string) {
	//gosec:disable G703
	f, err := os.Create(outputPath) //#nosec G703 - path is validated above
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}
	defer f.Close()
}
