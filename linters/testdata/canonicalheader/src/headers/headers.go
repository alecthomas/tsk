// Adapted from github.com/lasiar/canonicalheader's tests, MIT License.
package headers

import (
	"fmt"
	"net/http"
)

const constTestHeader = "testHeaderValue"

func common() {
	v := http.Header{}
	v.Get(constTestHeader) // want `use "Testheadervalue" instead of "testHeaderValue"`

	v.Get("Test-HEader")           // want `use "Test-Header" instead of "Test-HEader"`
	v.Set("Test-HEader", "value")  // want `use "Test-Header" instead of "Test-HEader"`
	v.Add("Test-HEader", "value")  // want `use "Test-Header" instead of "Test-HEader"`
	v.Del("Test-HEader")           // want `use "Test-Header" instead of "Test-HEader"`
	v.Values("Test-HEader")        // want `use "Test-Header" instead of "Test-HEader"`
	v.Values(`Raw-STRING-Literal`) // want `use "Raw-String-Literal" instead of "Raw-STRING-Literal"`

	v.Set("Test-Header", "value")
	v.Get("ETag")
	v.Get("Etag") // want `use "ETag" instead of "Etag"`
	v.Get("Has Space")

	var someString = ""
	v.Get(someString)
	v.Write(nil)
}

type myHeader = http.Header

func alias() {
	myHeader{}.Get("TT") // want `use "Tt" instead of "TT"`
}

func assigned() {
	h := http.Header{}

	i, g := 0, h.Del
	fmt.Println(i)
	g("TT") // want `use "Tt" instead of "TT"`

	f := h.Get
	f("TT") // want `use "Tt" instead of "TT"`
}

const (
	noCanonical = `TT`
	canonical   = "Tt"
)

const copiedFromNoCanonical = noCanonical

type myString string

const underlyingString myString = "TT"

func constants() {
	var mstr myString = "Tt"
	http.Header{}.Get(string(mstr))
	http.Header{}.Get(string(underlyingString)) // want `use "Tt" instead of "TT"`
	http.Header{}.Get(noCanonical)              // want `use "Tt" instead of "TT"`
	http.Header{}.Get(copiedFromNoCanonical)    // want `use "Tt" instead of "TT"`
	http.Header{}.Get(canonical)
}

type embedded struct {
	http.Header
}

type headerStruct struct {
	header http.Header
}

func fields() {
	embedded{}.Get("TT")            // want `use "Tt" instead of "TT"`
	headerStruct{}.header.Get("TT") // want `use "Tt" instead of "TT"`
}

func st(str string) string { return str }

func conversions() {
	http.Header{}.Get(st("hello-world"))
	http.Header{}.Get(string(string(myString("TT")))) // want `use "Tt" instead of "TT"`
}
