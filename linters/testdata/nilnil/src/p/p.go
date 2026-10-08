// Adapted from github.com/Antonboom/nilnil's tests, MIT License.
package p

import (
	"errors"
	"io"
	"unsafe"
)

type User struct{}

type Handler func()

func _() (*User, error) {
	return nil, nil // want "^return both a `nil` error and an invalid value: use a sentinel error instead$"
}

func _() (io.Reader, error) {
	return nil, nil // want "invalid value"
}

func _() (map[string]int, error) {
	return nil, nil // want "invalid value"
}

func _() (Handler, error) {
	return nil, nil // want "invalid value"
}

func _() (uintptr, error) {
	return 0x0, nil // want "invalid value"
}

func _() (unsafe.Pointer, error) {
	return nil, nil // want "invalid value"
}

func _() (*User, error) {
	return &User{}, errors.New("x")
}

func _() (*User, error) {
	return nil, errors.New("x")
}

func _() (User, error) {
	return User{}, nil
}

func _() (a, b *User, err error) {
	return nil, nil, nil
}

func _() {
	_ = func() (chan int, error) {
		return nil, nil // want "invalid value"
	}
}
