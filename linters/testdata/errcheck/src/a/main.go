// Adapted from github.com/kisielk/errcheck's tests, MIT License,
// Copyright (c) 2013 Kamil Kisiel.
package a

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"math/rand"
	mrand "math/rand"
	"os"
)

func a() error {
	fmt.Println("this function returns an error") // ok, excluded
	return nil
}

func b() (int, error) {
	return 0, nil
}

func c() int {
	return 7
}

func rec() {
	defer func() {
		recover()     // want "^Error return value is not checked$"
		_ = recover() // ok, assigned to blank
	}()
	defer recover() // want "^Error return value is not checked$"
}

type MyError string

func (e MyError) Error() string {
	return string(e)
}

func customError() error {
	return MyError("an error occurred")
}

func customConcreteError() MyError {
	return MyError("an error occurred")
}

func customConcreteErrorTuple() (int, MyError) {
	return 0, MyError("an error occurred")
}

type MyPointerError string

func (e *MyPointerError) Error() string {
	return string(*e)
}

func customPointerError() *MyPointerError {
	e := MyPointerError("an error occurred")
	return &e
}

type ErrorMakerInterface interface {
	MakeNilError() error
}
type ErrorMakerInterfaceWrapper interface {
	ErrorMakerInterface
}

func main() {
	_ = a() // ok, assigned to blank
	a()     // want "^Error return value is not checked$"

	_, _ = b() // ok, assigned to blank
	b()        // want "is not checked"

	customError()              // want "is not checked"
	customConcreteError()      // want "is not checked"
	customConcreteErrorTuple() // want "is not checked"
	customPointerError()       // want "is not checked"

	x := t{}
	_ = x.a() // ok, assigned to blank
	x.a()     // want "^Error return value of `x.a` is not checked$"

	x2 := embedtalias{}
	x2.a() // want "is not checked"

	var x4 embedtptralias
	x4.a() // want "is not checked"

	y := u{x}
	y.t.a() // want "^Error return value of `y.t.a` is not checked$"

	m1 := map[string]func() error{"a": a}
	m1["a"]() // want "^Error return value is not checked$"

	z, _ := b()    // ok, assigned to blank
	_, w := a(), 5 // ok, assigned to blank
	_ = c()
	_ = z + w

	var i interface{}
	s1 := i.(string)    // ok, would fail with check-type-assertions
	s2, _ := i.(string) // ok, would fail with check-blank
	switch s4 := i.(type) {
	case string:
		_ = s4
	}
	_, _ = s1, s2

	go a()    // want "is not checked"
	defer a() // want "is not checked"

	b1 := bytes.Buffer{}
	b2 := &bytes.Buffer{}
	b1.Write(nil)
	b2.Write(nil)
	rand.Read(nil)
	mrand.Read(nil)
	sha256.New().Write([]byte{})
	fmt.Fprintln(os.Stderr, "excluded")
	fmt.Fprintln(&b1, "excluded")
	fmt.Fprintln(os.Stdout, "checked") // want "^Error return value of `fmt.Fprintln` is not checked$"

	os.ReadFile("main.go") // want "^Error return value of `os.ReadFile` is not checked$"

	var emiw ErrorMakerInterfaceWrapper
	emiw.MakeNilError() // want "^Error return value of `emiw.MakeNilError` is not checked$"
}

// A pruned declaration last in this file must not hide calls in other files.
var assertedLast = (interface{})(nil).(string)
