// Adapted from github.com/mgechev/revive's tests, MIT License.
package enforcemapstyleany

func somefn() {
	m1 := make(map[string]string)
	m2 := map[string]string{}
	m3 := make(map[string]string, 10)
	m4 := map[string]string{"k1": "v1"}

	_ = m1
	_ = m2
	_ = m3
	_ = m4
}
