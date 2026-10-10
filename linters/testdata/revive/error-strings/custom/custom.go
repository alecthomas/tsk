// Adapted from github.com/mgechev/revive's tests, MIT License.

package custom

import (
	"errors"
	"fmt"

	pkgErrors "example.com/revive/error-strings/pkgerrors"
)

// Check for the error strings themselves.

func errorsStrings(x int) error {
	var err error
	return pkgErrors.Wrap(err, "This %d is too low") // want `^error-strings: error strings should not be capitalized or end with punctuation or a newline$`
}

func issue1243() {
	err := errors.New("An error occurred!") // want `^error-strings: error strings should not be capitalized or end with punctuation or a newline$`
	fmt.Println(err)
}
