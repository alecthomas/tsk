// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

const Ω = "Omega" // want "^banned character found: Ω$"

// func contains banned characters Ω // authorized banned chars in comment
func funcΣ() string { // want "^banned character found: Σ$"
	var charσhid string // want "^banned character found: σ$"
	return charσhid     // want "^banned character found: σ$"
}

var ΩΣ = "Omega Sigma" // want "^banned character found: Ω$" "^banned character found: Σ$"
