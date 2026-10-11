// Tests expressions that cgo rewrites, whose raw form has no typed copy.

package rewritten

// void f(void *ptr) {}
// void g(void *a, void *b) {}
import "C"

import "unsafe"

type T struct {
	s []int
	i int
}

func Rewritten() {
	var arr [2][]int
	var ints [2]int
	var t T
	var pa *[2][]int
	C.f(unsafe.Pointer(&arr[0])) // want "embedded pointer"
	C.f(unsafe.Pointer(&ints[0]))
	C.f(unsafe.Pointer(&(arr[1]))) // want "embedded pointer"
	C.f(unsafe.Pointer(&pa[0]))    // want "embedded pointer"
	C.f(unsafe.Pointer(&t.s))      // want "embedded pointer"
	C.f(unsafe.Pointer(&t.i))
	C.g(unsafe.Pointer(&ints), unsafe.Pointer(&arr)) // want "embedded pointer"
}
