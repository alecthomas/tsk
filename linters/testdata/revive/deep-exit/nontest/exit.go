// Adapted from github.com/mgechev/revive's tests, MIT License.
package nontest

import (
	"flag"
	"log"
	"os"
	"syscall"
	"testing"
)

func foo0() {
	os.Exit(1) // want "^deep-exit: calls to os.Exit only in main\\(\\) or init\\(\\) functions$"
}

func init() {
	log.Fatal("v ...interface{}")
}

func foo() {
	log.Fatalf("%d", 1) // want "^deep-exit: calls to log.Fatalf only in main\\(\\) or init\\(\\) functions$"
}

func main() {
	log.Fatalln("v ...interface{}")
}

func bar() {
	log.Fatal(1) // want "^deep-exit: calls to log.Fatal only in main\\(\\) or init\\(\\) functions$"
}

func bar2() {
	bar()
	syscall.Exit(1) // want "^deep-exit: calls to syscall.Exit only in main\\(\\) or init\\(\\) functions$"
}

func TestMain(m *testing.M) {
	// must match because this is not a test file
	os.Exit(m.Run()) // want "^deep-exit: calls to os.Exit only in main\\(\\) or init\\(\\) functions$"
}

func flagParseOutsideMain() {
	flag.Parse() // want "^deep-exit: calls to flag.Parse only in main\\(\\) or init\\(\\) functions; move the call or refactor to use flag.NewFlagSet with flag.ContinueOnError$"
}

func flagNewFlagSetExitOnErrorOutsideMain() {
	flag.NewFlagSet("cmd", flag.ExitOnError) // want "^deep-exit: calls to flag.NewFlagSet with flag.ExitOnError only in main\\(\\) or init\\(\\) functions$"
}

func flagNewFlagSetContinueOnErrorOK() {
	flag.NewFlagSet("cmd", flag.ContinueOnError)
}

// Not a testable example because this is not a test file
func Example() {
	os.Exit(1) // want "^deep-exit: calls to os.Exit only in main\\(\\) or init\\(\\) functions$"
}

func literal() {
	f := func() {
		log.Panic("x") // want "^deep-exit: calls to log.Panic only in main\\(\\) or init\\(\\) functions$"
	}
	f()
}
