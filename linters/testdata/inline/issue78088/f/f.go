//go:build go1.26
package f

import (
	"io/fs"
	"example.com/e"
)

func AsPathError(err error) (*fs.PathError, bool) {
	return e.As[*fs.PathError](err) // want "Call of e.As should be inlined"
}

