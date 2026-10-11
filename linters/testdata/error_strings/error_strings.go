// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package errorstrings tests error-strings.
package errorstrings

import (
	"fmt"

	"example.com/revive/error-strings/pkgerrors"
)

type stack struct{}

func (stack) Push(any) {}

var d struct{ stack stack }

// Check for the error strings themselves.

func g(x int) error {
	var err error
	err = fmt.Errorf("This %d is too low", x)
	err = fmt.Errorf("XML time")                  // ok
	err = fmt.Errorf("newlines are fun\n")        // want `^error strings should not be capitalized or end with punctuation or a newline$`
	err = fmt.Errorf("Newlines are really fun\n") // want `^error strings should not be capitalized or end with punctuation or a newline$`
	err = errors.New(`too much stuff.`)           // want `^error strings should not be capitalized or end with punctuation or a newline$`
	err = errors.New("This %d is too low", x)
	err = errors.New("GitHub should be ok", x)
	err = errors.New("OTP should be ok", x)
	err = errors.New("A JSON should be not ok", x)
	err = errors.New("H264 should be ok", x)
	err = errors.New("I/O should be ok", x)
	err = errors.New("U.S. should be ok", x)
	err = errors.New("Wi-Fi should be ok", x)
	err = errors.New("Élan should be not ok")
	err = errors.New("ÉLAN should be ok")
	err = errors.New("Über Alles should be not ok")

	// Non-regression test for issue #610
	d.stack.Push(1)

	return err
}

func errorsStrings(x int) error {
	var err error
	err = errors.Wrap(err, "This %d is too low")
	err = errors.New("This %d is too low")
	err = errors.Wrapf(err, "This %d is too low", x)
	err = errors.WithMessage(err, "This %d is too low")
	err = errors.WithMessagef(err, "This %d is too low", x)
	err = errors.Errorf("")
	return err
}
