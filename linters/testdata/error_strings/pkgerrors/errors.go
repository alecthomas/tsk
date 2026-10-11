// Package errors stands in for github.com/pkg/errors.
package errors

func New(message string, args ...any) error                    { return nil }
func Errorf(format string, args ...any) error                  { return nil }
func Wrap(err error, message string) error                     { return nil }
func Wrapf(err error, format string, args ...any) error        { return nil }
func WithMessage(err error, message string) error              { return nil }
func WithMessagef(err error, format string, args ...any) error { return nil }
