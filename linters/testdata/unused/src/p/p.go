// Adapted from staticcheck's unused tests, MIT License.
package p

const (
	a = iota // used through b, in the same group
	b
)

const unusedConst = 1 // want "^const unusedConst is unused$"

var unusedVar int // want "^var unusedVar is unused$"

type unusedType struct{} // want "^type unusedType is unused$"

type t struct {
	used   int
	unused int // want "^field unused is unused$"
	Public int
}

func (t) unusedMethod() {} // want `^func t.unusedMethod is unused$`

func (*t) unusedPointerMethod() {} // want `^func \(\*t\).unusedPointerMethod is unused$`

func (t) String() string { return "" }

func unusedFunc() {} // want "^func unusedFunc is unused$"

func usesGroup() int { return b }

var _ = usesGroup

//lint:ignore U1000 kept for later
func ignored() {}

func Exported() int {
	var v t
	v.used = 1
	return v.used
}

type iface interface{ m() }

type impl struct{}

func (impl) m() {}

var _ iface = impl{}
