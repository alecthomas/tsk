// Adapted from github.com/curioswitch/go-reassign's tests, MIT License.
package p

import (
	"io"
	"net/http"
	. "os"
)

var ErrLocal = io.EOF

func _() {
	io.EOF = nil                     // want "^reassigning variable EOF in other package io$"
	http.ErrServerClosed = nil       // want "reassigning variable ErrServerClosed in other package http"
	ErrNotExist = nil                // want "^reassigning variable ErrNotExist from other package os$"
	http.DefaultClient = nil
	ErrLocal = nil
	var s struct{ ErrX error }
	s.ErrX = nil
}
