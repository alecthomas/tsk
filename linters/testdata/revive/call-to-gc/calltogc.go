// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package calltogc tests call-to-gc.
package calltogc

import (
	"fmt"
	"runtime"
)

func GC() {
}

func foo() {
	fmt.Println("just testing")
	GC()
	runtime.Goexit()
	runtime.GC() // want "^call-to-gc: explicit call to the garbage collector$"
}
