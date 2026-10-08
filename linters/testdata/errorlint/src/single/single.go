package single

import (
	"errors"
	"fmt"
)

func Errorf() error {
	err := errors.New("oops")
	_ = fmt.Errorf("one: %w", err)
	_ = fmt.Errorf("two: %w %w", err, err) // want "^only one %w verb is permitted per format string$"
	return fmt.Errorf("lost: %v", err)     // want "^non-wrapping format verb"
}

func Compare(err error) bool {
	return err == errors.ErrUnsupported // disabled with comparison = false
}
