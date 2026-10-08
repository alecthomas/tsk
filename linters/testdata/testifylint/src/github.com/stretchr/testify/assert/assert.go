// Package assert stands in for github.com/stretchr/testify/assert.
package assert

type TestingT interface {
	Errorf(format string, args ...interface{})
}

func Equal(t TestingT, expected, actual interface{}, msgAndArgs ...interface{}) bool { return true }
func Equalf(t TestingT, expected, actual interface{}, msg string, args ...interface{}) bool {
	return true
}
func NotEqual(t TestingT, expected, actual interface{}, msgAndArgs ...interface{}) bool { return true }
func True(t TestingT, value bool, msgAndArgs ...interface{}) bool                      { return true }
func False(t TestingT, value bool, msgAndArgs ...interface{}) bool                     { return true }
func Len(t TestingT, object interface{}, length int, msgAndArgs ...interface{}) bool   { return true }
func Empty(t TestingT, object interface{}, msgAndArgs ...interface{}) bool             { return true }
func Nil(t TestingT, object interface{}, msgAndArgs ...interface{}) bool               { return true }
func Error(t TestingT, err error, msgAndArgs ...interface{}) bool                      { return true }
func NoError(t TestingT, err error, msgAndArgs ...interface{}) bool                    { return true }
func Greater(t TestingT, e1, e2 interface{}, msgAndArgs ...interface{}) bool           { return true }
