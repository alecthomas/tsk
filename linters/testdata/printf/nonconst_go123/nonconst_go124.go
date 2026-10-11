//go:build go1.24
package nonconst

import (
	"fmt"
	"log"
	"os"
)

// With Go 1.24, the analyzer should be activated, as this is a go1.24 file.
func _(s string) {
	fmt.Printf(s) // want `non-constant format string in call to fmt.Printf`
	fmt.Printf(s, "arg")
	fmt.Fprintf(os.Stderr, s) // want `non-constant format string in call to fmt.Fprintf`
	log.Printf(s)             // want `non-constant format string in call to log.Printf`
}
