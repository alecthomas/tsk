// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package unusedreceiver tests unused-receiver.
package unusedreceiver

import (
	"fmt"
)

type Unix struct{ path []string }

type Failure struct {
	Position struct{ Start int }
	RuleName string
	Failure  string
}

var failures []Failure

func (f *Unix) Name() string { // want "^unused-receiver: method receiver 'f' is not referenced in method's body, consider removing or renaming it as _$"
	return "unix"
}

func (f *Unix) Format(failures <-chan Failure, _ map[string]any) (string, error) { // want "^unused-receiver: method receiver 'f' is not referenced in method's body, consider removing or renaming it as _$"
	for failure := range failures {
		fmt.Printf("%v: [%s] %s\n", failure.Position.Start, failure.RuleName, failure.Failure)
	}
	return "", nil
}

func (u *Unix) Foo() (string, error) { // want "^unused-receiver: method receiver 'u' is not referenced in method's body, consider removing or renaming it as _$"
	for range failures {
		u := 1 // shadowing the receiver
		fmt.Printf("%v\n", u)
	}
	return "", nil
}

func (u *Unix) Foos() (*Unix, error) {
	for range failures {
		u := 1 // shadowing the receiver
		fmt.Printf("%v\n", u)
	}

	return u, nil // use of the receiver
}

func (u *Unix) Bar() (string, error) {
	for range failures {
		u.path = nil // modifies the receiver
		fmt.Printf("%v\n", u)
	}
	return "", nil
}

func (Unix) anonymous() {}

func (_ Unix) blank() {}
