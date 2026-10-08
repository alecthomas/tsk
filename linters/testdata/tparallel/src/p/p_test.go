// Adapted from github.com/moricho/tparallel's tests, MIT License.
package p

import "testing"

func TestTopOnly(t *testing.T) { // want "^TestTopOnly's subtests should call t.Parallel$"
	t.Parallel()
	t.Run("sub", func(t *testing.T) {})
}

func TestSubOnly(t *testing.T) { // want "^TestSubOnly should call t.Parallel on the top level as well as its subtests$"
	t.Run("sub", func(t *testing.T) {
		t.Parallel()
	})
}

func TestDefer(t *testing.T) { // want "^TestDefer should use t.Cleanup instead of defer$"
	t.Parallel()
	defer func() {}()
	t.Run("sub", func(t *testing.T) {
		t.Parallel()
	})
}

func TestBoth(t *testing.T) {
	t.Parallel()
	t.Run("sub", func(t *testing.T) {
		t.Parallel()
	})
}

func TestHelper(t *testing.T) { // want "TestHelper's subtests should call t.Parallel"
	t.Parallel()
	run(t)
}

func run(t *testing.T) {
	t.Run("sub", func(t *testing.T) {})
}

func TestNoSubtests(t *testing.T) {
	t.Parallel()
}
