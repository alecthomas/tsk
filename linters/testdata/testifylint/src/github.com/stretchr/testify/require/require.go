// Package require stands in for github.com/stretchr/testify/require.
package require

type TestingT interface {
	Errorf(format string, args ...interface{})
	FailNow()
}

func Equal(t TestingT, expected, actual interface{}, msgAndArgs ...interface{}) {}
func NoError(t TestingT, err error, msgAndArgs ...interface{})                  {}
