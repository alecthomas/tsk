// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package errorf tests errorf.
package errorf

import (
	"errors"
	"fmt"
	"testing"
)

func f(x int) error {
	if x > 10 {
		return errors.New(fmt.Sprintf("something %d", x)) // want `^errorf: should replace errors\.New\(fmt\.Sprintf\(\.\.\.\)\) with fmt\.Errorf\(\.\.\.\)$`
	}
	if x > 5 {
		return errors.New(g("blah")) // ok
	}
	if x > 4 {
		return errors.New("something else") // ok
	}
	return nil
}

// TestF is a dummy test
func TestF(t *testing.T) error {
	x := 1
	if x > 10 {
		t.Error(fmt.Sprintf("something %d", x)) // want `^errorf: should replace t\.Error\(fmt\.Sprintf\(\.\.\.\)\) with t\.Errorf\(\.\.\.\)$`
	}
	if x > 5 {
		t.Error(g("blah")) // ok
	}
	if x > 4 {
		t.Error("something else") // ok
	}
	return nil
}

func g(s string) string { return "prefix: " + s }
