// Adapted from github.com/gostaticanalysis/nilerr's tests, MIT License.
package p

import (
	"errors"
	"fmt"
)

func do() error { return nil }

func _() error {
	err := do()
	if err != nil {
		return nil // want "^error is not nil \\(line 12\\) but it returns nil$"
	}
	return nil
}

func _() error {
	err := do()
	if err == nil {
		return err // want "^error is nil \\(line 20\\) but it returns error$"
	}
	return nil
}

func _(b bool) error {
	var err error
	if b {
		err = do()
	} else {
		err = errors.New("x")
	}
	if err != nil {
		return nil // want "^error is not nil \\(lines \\[30 32\\]\\) but it returns nil$"
	}
	return nil
}

func _() error {
	err := do()
	if err != nil {
		fmt.Println(err)
		return nil
	}
	return nil
}

func _() error {
	err := do()
	if err != nil {
		//lint:ignore nilerr reason
		return nil
	}
	return nil
}

func _() error {
	err := do()
	if err != nil {
		return err
	}
	return nil
}
