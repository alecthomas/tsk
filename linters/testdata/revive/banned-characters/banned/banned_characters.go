// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

const Ω = "Omega" // want "^banned-characters: banned character found: Ω$"

// func contains banned characters Ω // authorized banned chars in comment
func funcΣ() string { // want "^banned-characters: banned character found: Σ$"
	var charσhid string // want "^banned-characters: banned character found: σ$"
	return charσhid     // want "^banned-characters: banned character found: σ$"
}

var ΩΣ = "Omega Sigma" // want "^banned-characters: banned character found: Ω$" "^banned-characters: banned character found: Σ$"
