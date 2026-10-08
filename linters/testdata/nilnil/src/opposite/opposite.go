// Adapted from github.com/Antonboom/nilnil's tests, MIT License.
package opposite

import "errors"

type User struct{}

func _() (*User, error) {
	return &User{}, errors.New("x") // want "^return both a non-nil error and a valid value: use separate returns instead$"
}

func _() (*User, error) {
	return nil, nil // want "invalid value"
}

func _() (chan int, error) {
	return nil, nil
}

func _() (map[string]int, error) {
	return nil, nil // want "invalid value"
}

func _() (*User, *User, error) {
	return nil, nil, nil // want "invalid value"
}
