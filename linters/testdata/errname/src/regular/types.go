package regular

import "strings"

type NotErrorType struct{}

func (t NotErrorType) Set() {}

type DNSConfigError struct{}

func (D DNSConfigError) Error() string { return "DNS config error" }

type someTypeWithoutPtr struct{}           // want "the error type name `someTypeWithoutPtr` should conform to the `xxxError` format"
func (s someTypeWithoutPtr) Error() string { return "someTypeWithoutPtr" }

type SomeTypeWithoutPtr struct{}           // want "the error type name `SomeTypeWithoutPtr` should conform to the `XxxError` format"
func (s SomeTypeWithoutPtr) Error() string { return "SomeTypeWithoutPtr" }

type someTypeWithPtr struct{}            // want "the error type name `someTypeWithPtr` should conform to the `xxxError` format"
func (s *someTypeWithPtr) Error() string { return "someTypeWithPtr" }

type (
	SomeTypeAlias = SomeTypeWithPtr // want "the error type name `SomeTypeAlias` should conform to the `XxxError` format"

	SomeTypeWithPtr struct{} // want "the error type name `SomeTypeWithPtr` should conform to the `XxxError` format"
)

func (s *SomeTypeWithPtr) Error() string { return "SomeTypeWithPtr" }

type timeoutErr struct { // want "the error type name `timeoutErr` should conform to the `xxxError` format"
	error
}

type ValidationErrors []string

func (ve ValidationErrors) Error() string { return strings.Join(ve, "\n") }

type TenErrors [10]string

func (te TenErrors) Error() string { return strings.Join(te[:], "\n") }

type MultiErr []error             // want "the error type name `MultiErr` should conform to the `XxxErrors` or `XxxError` format"
func (me MultiErr) Error() string { return "" }

type twoErrorss [2]error              // want "the error type name `twoErrorss` should conform to the `xxxErrors` or `xxxError` format"
func (te twoErrorss) Error() string { return te[0].Error() }

type MultiError []error

func (me MultiError) Error() string { return "" }

type ValErr[A, B any] struct{}     // want "the error type name `ValErr` should conform to the `XxxError` format"
func (ValErr[A, B]) Error() string { return "boom!" }

func local() {
	type localErr struct{ error }
	_ = localErr{}
}
