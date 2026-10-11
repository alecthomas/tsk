package nonconst

import (
	"fmt"
	"log"
	"os"
)

func _(s string) {
	fmt.Printf(s)
	fmt.Printf(s, "arg")
	fmt.Fprintf(os.Stderr, s)
	log.Printf(s)
}
