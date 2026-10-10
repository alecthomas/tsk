// Adapted from github.com/mgechev/revive's tests, MIT License.
package constantlogicalexpr

import "fmt"

// from github.com/ugorji/go/codec/helper.go
func isNaN(f float64) bool { return f != f } // want `^constant-logical-expr: expression always evaluates to false$`

func skip(f float64) bool { return f != g }

func foo1(f float64) bool { return foo2(2.) > foo2(2.) } // want `^constant-logical-expr: expression always evaluates to false$`

func foo2(f float64) bool { return f < f } // want `^constant-logical-expr: expression always evaluates to false$`

func foo3(f float64) bool { return f <= f } // want `^constant-logical-expr: expression always evaluates to true$`

func foo4(f float64) bool { return f >= f } // want `^constant-logical-expr: expression always evaluates to true$`

func foo5(f float64) bool { return f == f } // want `^constant-logical-expr: expression always evaluates to true$`

func foo6(f float64) bool { return fmt.Sprintf("%s", buf1.Bytes()) == fmt.Sprintf("%s", buf1.Bytes()) } // want `^constant-logical-expr: expression always evaluates to true$`

func foo7(f float64) bool {
	return fFoo(fBar(isNaN(10.), bpar), 10000) || fFoo(fBar(isNaN(10.), bpar), 10000) // want `^constant-logical-expr: left and right hand-side sub-expressions are the same$`
}

func foo8(f float64) bool {
	return fFoo(fBar(isNaN(10.), bpar), 10000) && fFoo(fBar(isNaN(10.), bpar), 10000) // want `^constant-logical-expr: left and right hand-side sub-expressions are the same$`
}
