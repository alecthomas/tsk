// Adapted from github.com/butuzov/mirror's tests, MIT License.
package p

import (
	"bytes"
	"regexp"
	"strings"
	. "unicode/utf8"
	str "strings"
)

func _(s string, b []byte, r rune, re *regexp.Regexp, buf *bytes.Buffer, sb strings.Builder) {
	_ = bytes.Compare([]byte(s), []byte(s)) // want `^avoid allocations with strings\.Compare$`
	_ = bytes.Compare([]byte(s), b)
	_ = str.Contains(string(b), string(b)) // want `avoid allocations with bytes\.Contains`
	_ = strings.ContainsAny(string(b), "ab") // want `avoid allocations with bytes\.ContainsAny`
	_ = ValidString(string(b))               // want `avoid allocations with utf8\.Valid`
	_, _ = regexp.MatchString("a+", string(b)) // want `avoid allocations with regexp\.Match`
	_ = re.MatchString(string(b))            // want `^avoid allocations with \(\*regexp\.Regexp\)\.Match$`
	buf.Write([]byte(s))                     // want `avoid allocations with \(\*bytes\.Buffer\)\.WriteString`
	buf.WriteString(string(r))               // want `avoid allocations with \(\*bytes\.Buffer\)\.WriteRune`
	sb.WriteString(string(b))                // want `avoid allocations with \(\*strings\.Builder\)\.Write`
	sb.WriteString(s)
}
