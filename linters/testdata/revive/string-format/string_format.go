// Adapted from github.com/mgechev/revive's tests, MIT License.

// Test string literal regex checks

package stringformat

func stringFormatMethod1(a, b string) {

}

func stringFormatMethod2(a, b string, c struct {
	d string
}) {

}

type stringFormatMethods struct{}

func (s stringFormatMethods) Method3(a, b, c string) {

}

type stringFormatMethodsInjected struct{}

func (s stringFormatMethodsInjected) Method4(a, b, c string) {

}

type container struct {
	s stringFormatMethodsInjected
}

func stringFormat() {
	stringFormatMethod1("This string is fine", "")
	stringFormatMethod1("this string is not capitalized", "") // want `^string-format: must start with a capital letter$`
	stringFormatMethod2("", "", struct {
		d string
	}{
		d: "This string is capitalized, but ends with a period."}) // want `^string-format: string literal doesn't match user defined regex /\[\^\\\.\]\$/$`
	s := stringFormatMethods{}
	s.Method3("", "", "This string starts with th") // want `^string-format: must not start with 'th'$`

	c := container{
		s: stringFormatMethodsInjected{},
	}
	c.s.Method4("Other string starts with ot", "", "") // want `^string-format: must not start with 'ot'$`
}
