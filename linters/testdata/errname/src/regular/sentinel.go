// Adapted from github.com/Antonboom/errname's tests, MIT License,
// Copyright (c) 2021 Anton Telyshev.
package regular

import (
	"errors"
	"fmt"
	"io"
	"net"
)

var (
	EOF          = errors.New("end of file")
	ErrEndOfFile = errors.New("end of file")
	errEndOfFile = errors.New("end of file")

	EndOfFileError = errors.New("end of file") // want "the sentinel error name `EndOfFileError` should conform to the `ErrXxx` format"
	ErrorEndOfFile = errors.New("end of file") // want "the sentinel error name `ErrorEndOfFile` should conform to the `ErrXxx` format"
	EndOfFileErr   = errors.New("end of file") // want "the sentinel error name `EndOfFileErr` should conform to the `ErrXxx` format"
	endOfFileError = errors.New("end of file") // want "the sentinel error name `endOfFileError` should conform to the `errXxx` format"
	errorEndOfFile = errors.New("end of file") // want "the sentinel error name `errorEndOfFile` should conform to the `errXxx` format"
)

const maxSize = 256

var (
	ErrOutOfSize   = fmt.Errorf("out of size (max %d)", maxSize)
	OutOfSizeError = fmt.Errorf("out of size (max %d)", maxSize) // want "the sentinel error name `OutOfSizeError` should conform to the `ErrXxx` format"
)

func errInsideFuncIsNotSentinel() error {
	var lastErr error
	return lastErr
}

var _ = func() {
	run("", func() {
		var orderErr error
		_ = orderErr
	})
}

func run(_ string, _ func()) {}

var (
	ErrA = newSomeTypeWithPtr()
	ErrE = new(SomeTypeWithPtr)
	ErrG = SomeTypeWithoutPtr{}

	AErr = newSomeTypeWithPtr()    // want "the sentinel error name `AErr` should conform to the `ErrXxx` format"
	CErr = newSomeTypeWithoutPtr() // want "the sentinel error name `CErr` should conform to the `ErrXxx` format"
	FErr = &SomeTypeWithPtr{}      // want "the sentinel error name `FErr` should conform to the `ErrXxx` format"

	AErrr error = newSomeTypeWithPtr() // want "the sentinel error name `AErrr` should conform to the `ErrXxx` format"

	ErrByAnonymousFunc = func() error { return nil }
	ByAnonymousFuncErr = func() error { return io.EOF }() // want "the sentinel error name `ByAnonymousFuncErr` should conform to the `ErrXxx` format"

	InvalidAddrError = new(net.AddrError) // want "the sentinel error name `InvalidAddrError` should conform to the `ErrXxx` format"
	NotErr           = new(NotErrorType)

	Aa  = new(someTypeWithPtr) // want "the sentinel error name `Aa` should conform to the `ErrXxx` format"
	Bbb = someTypeWithPtr{}

	cC error = new(someTypeWithPtr) // want "the sentinel error name `cC` should conform to the `errXxx` format"

	Alias = AErrr // want "the sentinel error name `Alias` should conform to the `ErrXxx` format"
)

var InitializedLaterError error // want "the sentinel error name `InitializedLaterError` should conform to the `ErrXxx` format"

func newSomeTypeWithPtr() error {
	return new(SomeTypeWithPtr)
}

func newSomeTypeWithoutPtr() SomeTypeWithoutPtr {
	return SomeTypeWithoutPtr{}
}

type constError string

func (e constError) Error() string {
	return string(e)
}

const (
	ErrTooManyErrors constError = "too many errors found"
	ErrorTooMany1    constError = "too many errors found"             // want "the sentinel error name `ErrorTooMany1` should conform to the `ErrXxx` format"
	ErrorTooMany2               = constError("too many errors found") // want "the sentinel error name `ErrorTooMany2` should conform to the `ErrXxx` format"
)
