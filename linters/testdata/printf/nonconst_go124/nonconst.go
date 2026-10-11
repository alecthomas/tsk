package nonconst

import (
	"fmt"
	"log"
	"os"
)

func _(s string) {
	fmt.Printf(s) // want `non-constant format string in call to fmt.Printf`
	fmt.Printf(s, "arg")
	fmt.Fprintf(os.Stderr, s) // want `non-constant format string in call to fmt.Fprintf`
	log.Printf(s)             // want `non-constant format string in call to log.Printf`
}
