// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package unusedparameter tests unused-parameter.
package unusedparameter

import (
	"fmt"
	"os"
	"runtime"
	"time"
)

func fn() int                { return 0 }
func predicate(_ int) bool   { return true }
func someFunc(func([]int) float64) {}

var sum int

type myStruct struct{ field, c string }

func f0(param int) {
	{
		param := param
		_ = param
	}
}

func f1(param int) { // want "^unused-parameter: parameter 'param' seems to be unused, consider removing or renaming it as _$"
	if param := fn(); predicate(param) {
		// do stuff
	}
}

func f2(param int) { // want "^unused-parameter: parameter 'param' seems to be unused, consider removing or renaming it as _$"
	switch param := fn(); param {
	default:

	}
}

func f3(param myStruct) {
	a := param.field
	_ = a
}

func f4(param myStruct, c int) { // want "^unused-parameter: parameter 'c' seems to be unused, consider removing or renaming it as _$"
	param.field = "aString"
	param.c = "sss"
}

func f5(a int, _ float64) { // want "^unused-parameter: parameter 'a' seems to be unused, consider removing or renaming it as _$"
	fmt.Printf("Hello, Golang\n")
	{
		if true {
			a := 2
			b := a
			_ = b
		}
	}
}

func f6(unused string) { // want "^unused-parameter: parameter 'unused' seems to be unused, consider removing or renaming it as _$"
	switch unused := runtime.GOOS; unused {
	case "darwin":
		fmt.Println("OS X.")
	case "linux":
		fmt.Println("Linux.")
	default:
		fmt.Printf("%s.", unused)
	}
	for unused := 0; unused < 10; unused++ {
		sum += unused
	}
	{
		unused := 1
		_ = unused
	}
}

func f6bis(unused string) {
	switch unused := runtime.GOOS; unused {
	case "darwin":
		fmt.Println("OS X.")
	case "linux":
		fmt.Println("Linux.")
	default:
		fmt.Printf("%s.", unused)
	}
	for unused := 0; unused < 10; unused++ {
		sum += unused
	}
	{
		unused := 1
		_ = unused
	}

	fmt.Print(unused)
}

func f7(pl int) {
	for i := 0; pl < i; i-- {

	}
}

type node struct {
	ModifiedIndex uint64
	Value         string
}

const (
	CompareIndexNotMatch = iota
	CompareValueNotMatch
)

func getCompareFailCause(n *node, which int, prevValue string, prevIndex uint64) string {
	switch which {
	case CompareIndexNotMatch:
		return fmt.Sprintf("[%v != %v]", prevIndex, n.ModifiedIndex)
	case CompareValueNotMatch:
		return fmt.Sprintf("[%v != %v]", prevValue, n.Value)
	default:
		return fmt.Sprintf("[%v != %v] [%v != %v]", prevValue, n.Value, prevIndex, n.ModifiedIndex)
	}
}

func assertSuccess(baseDir string, fi os.FileInfo, src []byte) error { // want "^unused-parameter: parameter 'src' seems to be unused, consider removing or renaming it as _$"
	_, err := os.ReadFile(baseDir + fi.Name())
	return err
}

type lintCyclomatic struct{ complexity int }

func (w lintCyclomatic) Visit(n fmt.Stringer) int { // want "^unused-parameter: parameter 'n' seems to be unused, consider removing or renaming it as _$"
	return w.complexity
}

type frame struct{}
type value any

func ext۰time۰Sleep(fr *frame, args []value) value { // want "^unused-parameter: parameter 'fr' seems to be unused, consider removing or renaming it as _$"
	time.Sleep(time.Duration(args[0].(int64)))
	return nil
}

type chanList struct{ offset uint32 }

func (c *chanList) remove(id uint32) {
	id -= c.offset
}

func (c *chanList) remove1(id uint32) {
	id *= c.offset
}

func (c *chanList) remove2(id uint32) {
	id /= c.offset
}

func (c *chanList) remove3(id uint32) {
	id += c.offset
}

func encodeFixed64Rpc(dAtA []byte, offset int, v uint64, i int) int {
	dAtA[offset+i] = uint8(v)

	return 8
}

func innerAnonymousFunctionWithoutUsage() {
	innerFunc := func(a int) {} // want "^unused-parameter: parameter 'a' seems to be unused, consider removing or renaming it as _$"
	innerFunc(1)
}

func innerAnonymousFunctionWithUsage() {
	innerFunc := func(a int) {
		a += 1
	}
	innerFunc(1)

	someFunc(func(values []int) float64 { // want "^unused-parameter: parameter 'values' seems to be unused, consider removing or renaming it as _$"
		return 1.1
	})
}
