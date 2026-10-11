//go:build go1.23
package nonconst

import (
	"fmt"
	"log"
	"os"
)

// The analyzer should be silent, as this is a go1.23 file.
func _(s string) {
	fmt.Printf(s)
	fmt.Printf(s, "arg")
	fmt.Fprintf(os.Stderr, s)
	log.Printf(s)
}
