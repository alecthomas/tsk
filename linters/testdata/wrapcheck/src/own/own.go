package own

import "fmt"

func caller() error {
	return local() // want `^package-internal error should be wrapped: sig: func own.local\(\) error$`
}

func local() error { return nil }

func wrapped() error {
	return fmt.Errorf("x")
}
