// Adapted from github.com/kulti/thelper's tests, MIT license.
package t

import "testing"

func subtestBuilderAnotherFile() func(*testing.T) {
	return func(t *testing.T) {}
}
