// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package useerrorsnew tests that use-errors-new is off from Go 1.26.
package useerrorsnew

import "fmt"

func errorsNew(msg string) (int, error) {
	err := fmt.Errorf("repo cannot be nil")
	errs := append([]error{}, fmt.Errorf("commit cannot be nil"))
	fmt.Errorf("unable to load base repo: %w", err)
	fmt.Errorf("Failed to get full commit id for origin/%s: %w", "x", errs[0])

	return 0, fmt.Errorf(msg + "something")
}
