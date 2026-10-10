// Adapted from github.com/mgechev/revive's tests, MIT License.

// Test of return+else warning.

// Package superfluouselse ...
package superfluouselse

import (
	"errors"
	"fmt"
	"log"
	"os"
)

func f() bool { return false }

func f2() (int, bool) { return 0, false }

func get() (int, error) { return 0, nil }

var (
	errCourseNotFound = errors.New("not found")
	errCourseAccess   = errors.New("access")
	errAnother        = errors.New("another")
)

func h(f func() bool) string {
	for {
		if ok := f(); ok {
			a := 1
			_ = a
			continue
		} else { // want `^superfluous-else: if block ends with a continue statement, so drop this else and outdent its block \(move short variable declaration to its own line if necessary\)$`
			return "it's NOT okay!"
		}
	}
}

func i(f func() bool) string {
	for {
		if f() {
			a := 1
			_ = a
			continue
		} else { // want `^superfluous-else: if block ends with a continue statement, so drop this else and outdent its block$`
			log.Printf("non-positive")
		}
	}

	return "ok"
}

func j(f func() bool) string {
	for {
		if f() {
			break
		} else { // want `^superfluous-else: if block ends with a break statement, so drop this else and outdent its block$`
			log.Printf("non-positive")
		}
	}

	return "ok"
}

func k() {
	var a = 10
	/* do loop execution */
LOOP:
	for a < 20 {
		if a == 15 {
			a = a + 1
			goto LOOP
		} else { // want `^superfluous-else: if block ends with a goto statement, so drop this else and outdent its block$`
			fmt.Printf("value of a: %d\n", a)
			a++
		}
	}
}

func fatal1() string {
	if f() {
		a := 1
		_ = a
		log.Fatal("x")
	} else { // want `^superfluous-else: if block ends with call to log\.Fatal function, so drop this else and outdent its block$`
		log.Printf("non-positive")
	}
	return "ok"
}

func fatal2() string {
	if f() {
		a := 1
		_ = a
		log.Fatalf("x")
	} else { // want `^superfluous-else: if block ends with call to log\.Fatalf function, so drop this else and outdent its block$`
		log.Printf("non-positive")
	}
	return "ok"
}

func fatal3() string {
	if f() {
		a := 1
		_ = a
		log.Fatalln("x")
	} else { // want `^superfluous-else: if block ends with call to log\.Fatalln function, so drop this else and outdent its block$`
		log.Printf("non-positive")
	}
	return "ok"
}

func exit1() string {
	if f() {
		a := 1
		_ = a
		os.Exit(2)
	} else { // want `^superfluous-else: if block ends with call to os\.Exit function, so drop this else and outdent its block$`
		log.Printf("non-positive")
	}
	return "ok"
}

func Panic1() string {
	if f() {
		a := 1
		_ = a
		log.Panic(2)
	} else { // want `^superfluous-else: if block ends with call to log\.Panic function, so drop this else and outdent its block$`
		log.Printf("non-positive")
	}
	return "ok"
}

func Panic2() string {
	if f() {
		a := 1
		_ = a
		log.Panicf("2")
	} else { // want `^superfluous-else: if block ends with call to log\.Panicf function, so drop this else and outdent its block$`
		log.Printf("non-positive")
	}
	return "ok"
}

func Panic3() string {
	if f() {
		a := 1
		_ = a
		log.Panicln(2)
	} else { // want `^superfluous-else: if block ends with call to log\.Panicln function, so drop this else and outdent its block$`
		log.Printf("non-positive")
	}
	return "ok"
}

func Panic4() string {
	if f() {
		a := 1
		_ = a
		panic(2)
	} else { // want `^superfluous-else: if block ends with call to panic function, so drop this else and outdent its block$`
		log.Printf("non-positive")
	}
	return "ok"
}

// noreg_19 no-regression test for issue #19 (https://github.com/mgechev/revive/issues/19)
func noreg_19(err error) string {
	for {
		if err == errCourseNotFound {
			break
		} else if err == errCourseAccess {
			// side effect
		} else if err == errAnother {
			os.Exit(1) // "okay"
		} else {
			// side effect
		}
	}
	return ""
}

func MultiBranch(m map[int]int, x int) {
	for {
		if _, ok := f2(); ok {
			continue
		} else if _, err := get(); err == nil {
			continue
		} else { // want `^superfluous-else: if block ends with a continue statement, so drop this else and outdent its block \(move short variable declaration to its own line if necessary\)$`
			delete(m, x)
		}
	}
}
