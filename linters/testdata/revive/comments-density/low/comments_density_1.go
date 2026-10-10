// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures // want "^comments-density: the file has a comment density of 62% \\(5 comment lines for 3 code lines\\) but expected a minimum of 70%$"

// func contains banned characters Ω // authorized banned chars in comment
func cd1() string {
	// the var
	var charσhid string
	/* the return */
	return charσhid
}
