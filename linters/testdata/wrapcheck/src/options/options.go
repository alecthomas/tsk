package options

import (
	"encoding/json"
	"io"
)

func ignoredPackage() error {
	_, err := json.Marshal(1)
	return err
}

// An ignored interface still counts as an external package.
func ignoredInterface(r io.Reader) error {
	_, err := r.Read(nil)
	return err // want `^error returned from external package is unwrapped: sig: func \(io.Reader\).Read\(p \[\]byte\) \(n int, err error\)$`
}
