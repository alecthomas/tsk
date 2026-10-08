package basic

import "fmt"

func variadic(args ...any) {}

func withFormat(format string, args ...interface{}) {}

func typed(args ...int) {}

func calls() {
	values := []any{1, 2}
	variadic(values) // want `pass \[\]any as any to func variadic func\(args \.\.\.any\)`
	withFormat("%v", values) // want `pass \[\]any as any to func withFormat func\(format string, args \.\.\.interface\{\}\)`
	variadic(values...)
	variadic(1, values)
	variadic()
	typed(1, 2)
	fmt.Println(values)
	fmt.Sprintf("%v", values)
}

type recorder struct{}

func (recorder) Debugf(format string, args ...any) {}

func (recorder) Record(args ...any) {}

func methods(logger, other recorder) {
	values := []interface{}{1}
	logger.Debugf("%v", values)
	other.Debugf("%v", values) // want `pass \[\]any as any to func other\.Debugf`
	logger.Record(values) // want `pass \[\]any as any to func logger\.Record func\(args \.\.\.any\)`
}
