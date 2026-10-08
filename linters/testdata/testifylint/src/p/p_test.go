// Adapted from github.com/Antonboom/testifylint's tests, MIT License.
package p

import (
	"errors"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRegular(t *testing.T) {
	var (
		b        bool
		s        []int
		n        int
		f        float64
		name     string
		expected = 1
	)
	assert.Equal(t, true, b)                          // want "^bool-compare: use assert.True$"
	assert.True(t, b == true)                         // want "^bool-compare: need to simplify the assertion$"
	assert.Equal(t, 0, len(s))                        // want "^empty: use assert.Empty$"
	assert.Equal(t, 3, len(s))                        // want "^len: use assert.Len$"
	assert.True(t, n > 0)                             // want "^negative-positive: use assert.Positive$"
	assert.True(t, n == 5)                            // want "^compares: use assert.Equal$"
	assert.Equal(t, f, 1.5)                           // want `^float-compare: use assert.InEpsilon \(or InDelta\)$`
	assert.Equal(t, n, expected)                      // want "^expected-actual: need to reverse actual and expected values$"
	assert.Equalf(t, 1, n, "value %d")                // want "^formatter: assert.Equalf format %d reads arg #1, but call has 0 args$"
	assert.Equal(t, 1, n, fmt.Sprintf("value %d", n)) // want "^formatter: remove unnecessary fmt.Sprintf$"
	assert.True(t, true)                              // want "^useless-assert: meaningless assertion$"
	assert.Equal(t, name, name)                       // want "^useless-assert: asserting of the same variable$"
	assert.Greater(t, n, 1)
}

func TestErrors(t *testing.T) {
	var err error
	assert.Nil(t, err)                    // want "^error-nil: use assert.NoError$"
	assert.Error(t, err, errors.New("x")) // want "^error-is-as: invalid usage of assert.Error, use assert.ErrorIs instead$" "require-error"
	assert.NoError(t, err)                // want "require-error"
	assert.Equal(t, 1, 2)
	require.NoError(t, err)
	go func() {
		require.NoError(t, err) // want "^go-require: require must only be used in the goroutine running the test function$"
	}()
	if err != nil {
		assert.Error(t, err)
	}
}
