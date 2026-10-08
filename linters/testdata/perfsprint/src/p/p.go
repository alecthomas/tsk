// Adapted from github.com/catenacyber/perfsprint's tests, MIT License.
package p

import (
	"errors"
	"fmt"
)

func _(s string, err error, b bool, i int, i64 int64, u8 uint8, u64 uint64, bs []byte, arr [4]byte) {
	_ = fmt.Sprintf("%s", s)    // want "^string-format: fmt.Sprintf can be replaced with just using the string$"
	_ = fmt.Sprint(s)           // want "^string-format: fmt.Sprint can be replaced with just using the string$"
	_ = fmt.Errorf("failed")    // want "^error-format: fmt.Errorf can be replaced with errors.New$"
	_ = fmt.Sprintf("%v", err)
	_ = fmt.Sprintf("%t", b)    // want "^bool-format: fmt.Sprintf can be replaced with faster strconv.FormatBool$"
	_ = fmt.Sprintf("%d", i)    // want "^integer-format: fmt.Sprintf can be replaced with faster strconv.Itoa$"
	_ = fmt.Sprintf("%d", i64)  // want "strconv.FormatInt"
	_ = fmt.Sprintf("%x", u8)   // want "strconv.FormatUint"
	_ = fmt.Sprintf("%[1]d", u64) // want "strconv.FormatUint"
	_ = fmt.Sprintf("%x", bs)   // want "^hex-format: fmt.Sprintf can be replaced with faster hex.EncodeToString$"
	_ = fmt.Sprintf("%x", arr)  // want "hex.EncodeToString"
	_ = fmt.Sprintf("id-%s", s) // want "^string-format: fmt.Sprintf can be replaced with string concatenation$"
	_ = fmt.Sprintf("%s-%s", s, s)
	_ = fmt.Sprintf("%5d", i)
	_ = errors.New("ok")
}

func _(items []string) string {
	out := ""
	for _, item := range items {
		out += item // want "^concat-loop: string concatenation in a loop$"
	}
	return out
}

func _(items []string) string {
	out := ""
	for _, item := range items {
		out += item
		if len(out) > 10 {
			break
		}
	}
	return out
}
