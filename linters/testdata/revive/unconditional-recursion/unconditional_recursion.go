// Adapted from github.com/mgechev/revive's tests, MIT License.

package unconditionalrecursion

import (
	"log"
	"os"
	"time"
)

var aChannel chan int

func ur4() {}

func ur5() {}

func foo(any) int { return 0 }

func bar(...any) int { return 0 }

type fooType struct{}

func BarFunc() {}

func BazFunc() {}

func ur1() {
	ur1() // want `^unconditional-recursion: unconditional recursive call$`
}

func ur1bis() {
	if true {
		print()
	} else {
		switch {
		case true:
			println()
		default:
			for i := 0; i < 10; i++ {
				print()
			}
		}

	}

	ur1bis() // want `^unconditional-recursion: unconditional recursive call$`
}

func ur2tris() {
	for {
		println()
		ur2tris() // want `^unconditional-recursion: unconditional recursive call$`
	}
}

func ur2() {
	if true {
		return
	}

	ur2()
}

func ur3() {
	ur1()
}

func urn4() {
	if true {
		print()
	} else if false {
		return
	}

	ur4()
}

func urn5() {
	if true {
		return
	}

	if true {
		println()
	}

	ur5()
}

func ur2quater() {
	for true == false {
		println()
		ur2quater()
	}
}

type myType struct {
	foo int
	bar int
}

func (mt *myType) Foo() int {
	return mt.Foo() // want `^unconditional-recursion: unconditional recursive call$`
}

func (mt *myType) Bar() int {
	return mt.bar
}

func ur6() {
	switch {
	case true:
		return
	default:
		println()
	}

	ur6()
}

func ur7(a interface{}) {
	switch a.(type) {
	case int:
		return
	default:
		println()
	}

	ur7(a)
}

func ur8(a []int) {
	for range a {
		return
	}

	ur8(a)
}

func ur9(a []int) {
	for range a {
		ur9(a)
	}
}

func ur10() {
	select {
	case <-aChannel:
	case <-time.After(2 * time.Second):
		return
	}
	ur10()
}

func ur11() { // this pattern produces "infinite" number of goroutines
	go ur11() // want `^unconditional-recursion: unconditional recursive call$`
}

func ur12() int {
	go foo(ur12())                   // want `^unconditional-recursion: unconditional recursive call$`
	go bar(1, "string", ur12(), 1.0) // want `^unconditional-recursion: unconditional recursive call$`
	go foo(bar())
	return 0
}

func urn13() {
	if true {
		panic("")
	}
	urn13()
}

func urn14() {
	if true {
		os.Exit(1)
	}
	urn14()
}

func urn15() {
	if true {
		log.Panic("")
	}
	urn15()
}

func urn16(ch chan int) {
	for range ch {
		log.Panic("")
	}
	urn16(ch)
}

func urn17(ch chan int) {
	for range ch {
		print("")
	}
	urn17(ch) // want `^unconditional-recursion: unconditional recursive call$`
}

// Tests for #596
func (*fooType) BarFunc() {
	BarFunc()
}

func (_ *fooType) BazFunc() {
	BazFunc()
}

// Tests for #902
func falsePositiveFuncLiteral() {
	_ = foo(func() {
		falsePositiveFuncLiteral()
	})
}
func nr902() {
	go func() {
		nr902() // want `^unconditional-recursion: unconditional recursive call$`
	}()
}

// Test for issue #1212
func NewFactory() int {
	return 0
}

var defaultFactory = NewFactory()
