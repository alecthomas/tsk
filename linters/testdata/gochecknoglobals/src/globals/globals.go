// Adapted from github.com/leighmcculloch/gochecknoglobals's tests, MIT License.
package globals

import (
	"embed"
	"errors"
	"regexp"
)

var counter int // want `^counter is a global variable$`

var (
	a, b = 1, 2 // want `^a is a global variable$` `^b is a global variable$`
	_    = 3
)

var version = "1.0"

var ErrNotFound = errors.New("not found")

var errInternal = errors.New("internal")

// Named like an error, but not one.
var ErrCount = 1 // want `^ErrCount is a global variable$`

var pattern = regexp.MustCompile(`^a$`)

//go:embed globals.go
var source string

//go:embed globals.go
var files embed.FS

func local() {
	var x int
	_ = x
}
