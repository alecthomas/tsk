//go:build go1.26
package e

import "errors"

//go:fix inline
func As[T error](err error) (T, bool) { // want As:`goFixInline {"name":"e.As"`
	return errors.AsType[T](err)
}

