package p

import "os"

func inline() {
	if err := os.Remove("x"); err != nil { // want "^avoid inline error handling using `if err := ...; err != nil`; use plain assignment `err := ...`$"
		return
	}
}

func assigned() (err error) {
	if err = os.Remove("x"); err != nil { // want "^avoid inline error handling using `if err = ...; err != nil`; use plain assignment `err = ...`$"
		return err
	}
	return nil
}

func plain() {
	err := os.Remove("x")
	if err != nil {
		return
	}
}

func unrelated() {
	if n := len("x"); n > 0 {
		return
	}
}
