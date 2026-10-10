// Adapted from github.com/mgechev/revive's tests, MIT License.

package issue1063

import (
	"errors"
)

func ReturnError() error {
	return errors.New("This is an error.") // want `^string-format: must not start with a capital letter$`
}
