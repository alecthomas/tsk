// Adapted from github.com/catenacyber/perfsprint's tests, MIT License.
package options

import "fmt"

func _(s string, err error, i8 int8) {
	_ = fmt.Sprintf("id-%s", s)
	_ = fmt.Sprintf("%s", err) // want "^error-format: fmt.Sprintf can be replaced with err.Error\\(\\)$"
	_ = fmt.Sprintf("%d", i8)
}

func _(items []string) string {
	out := ""
	for _, item := range items {
		out += item // want "concat-loop"
		if len(out) > 10 {
			break
		}
	}
	return out
}
