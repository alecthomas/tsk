// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

func (this data) vmethod() {
	nil := true // want "^redefines-builtin-id: assignment creates a shadow of built-in identifier nil$"
	iota = 1 // want "^redefines-builtin-id: assignment modifies built-in identifier iota$"
}

func append(i, j int) { // want "^redefines-builtin-id: redefinition of the built-in function append$"

}

type string int16 // want "^redefines-builtin-id: redefinition of the built-in type string$"

func delete(set []int64, i int) (y []int64) { // want "^redefines-builtin-id: redefinition of the built-in function delete$"
	for j, v := range set {
		if j != i {
			y = append(y, v)
		}
	}
	return
}

type any int // want "^redefines-builtin-id: redefinition of the built-in type any$"

func any() {} // want "^redefines-builtin-id: redefinition of the built-in type any$"

var any int // want "^redefines-builtin-id: redefinition of the built-in type any$"

const any = 1 // want "^redefines-builtin-id: redefinition of the built-in type any$"

var i, copy int // want "^redefines-builtin-id: redefinition of the built-in function copy$"

// issue #792
type ()

func foo() {
	clear := 0 // Shall not match /redefinition of the built-in function clear/
	max := 0   // Shall not match /redefinition of the built-in function max/
	min := 0   // Shall not match /redefinition of the built-in function min/
	_ = clear
	_ = max
	_ = min
}

func foo1(new int) { // want "^redefines-builtin-id: redefinition of the built-in function new$"
	_ = new
}

func foo2() (new int) { // want "^redefines-builtin-id: redefinition of the built-in function new$"
	return
}

func foo3[new any]() { // want "^redefines-builtin-id: redefinition of the built-in function new$"
}

type comparable int // want "^redefines-builtin-id: redefinition of the built-in type comparable$"

func comparable() {} // want "^redefines-builtin-id: redefinition of the built-in type comparable$"

var comparable int // want "^redefines-builtin-id: redefinition of the built-in type comparable$"

const comparable = 1 // want "^redefines-builtin-id: redefinition of the built-in type comparable$"

func foo4[comparable any]() { // want "^redefines-builtin-id: redefinition of the built-in type comparable$"
}
