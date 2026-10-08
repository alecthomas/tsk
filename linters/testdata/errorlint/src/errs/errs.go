// Adapted from codeberg.org/polyfloyd/go-errorlint's tests, MIT License.
package errs

import (
	"bufio"
	"errors"
	"fmt"
	"io"
)

var ErrFoo = errors.New("foo")

type MyError struct{}

func (*MyError) Error() string { return "my error" }

func doThing() error { return nil }

func Errorf() error {
	err := doThing()
	_ = fmt.Errorf("wrapped: %w", err)
	_ = fmt.Errorf("value: %d", 1)
	_ = fmt.Errorf("both: %w %w", err, err)
	_ = fmt.Errorf("type: %T", err)
	return fmt.Errorf("lost: %v", err) // want "^non-wrapping format verb for fmt.Errorf. Use `%w` to format errors$"
}

func Compare() {
	err := doThing()
	if err == nil {
		return
	}
	if err == ErrFoo { // want "^comparing with == will fail on wrapped errors. Use errors.Is to check for a specific error$"
		return
	}
	if ErrFoo != err { // want "^comparing with != will fail on wrapped errors"
		return
	}
	if errors.Is(err, ErrFoo) {
		return
	}
}

func Switch() {
	err := doThing()
	switch err {
	case nil:
	case ErrFoo: // want "^switch on an error will fail on wrapped errors. Use errors.Is to check for specific errors$"
	}
	switch err {
	case nil:
	}
}

// Readers return io.EOF unwrapped, so it may be compared directly.
func Allowed(r *bufio.Reader) {
	_, err := r.ReadByte()
	if err == io.EOF {
		return
	}
	if err := doThing(); err == io.EOF { // want "^comparing with =="
		return
	}
}

func Assert() {
	err := doThing()
	if me, ok := err.(*MyError); ok { // want "^type assertion on error will fail on wrapped errors. Use errors.As to check for specific errors$"
		_ = me
	}
	_ = err.(*MyError) // want "^type assertion on error"
	switch err.(type) { // want "^type switch on error will fail on wrapped errors. Use errors.As to check for specific errors$"
	case *MyError:
	}
	var me *MyError
	if errors.As(err, &me) {
		return
	}
}

type isError struct{}

func (isError) Error() string { return "is" }

// Is compares errors directly, as its contract requires.
func (isError) Is(err error) bool {
	return err == ErrFoo
}
