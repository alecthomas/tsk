// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

var unexported string
var Exported string

func unexportednaming(
	S int, // want "^unexported-naming: the symbol S is local, its name should start with a lowercase letter$"
	s int,
) (
	Result bool, // want "^unexported-naming: the symbol Result is local, its name should start with a lowercase letter$"
	result bool,
) {
	var NotExportable int // want "^unexported-naming: the symbol NotExportable is local, its name should start with a lowercase letter$"
	var local float32
	{
		OtherNotExportable := 0 // want "^unexported-naming: the symbol OtherNotExportable is local, its name should start with a lowercase letter$"
		_ = OtherNotExportable
	}
	const NotExportableConstant = "local" // want "^unexported-naming: the symbol NotExportableConstant is local, its name should start with a lowercase letter$"
	_, _, _ = NotExportable, local, NotExportableConstant

	// Only the first spec of a declaration is checked.
	var (
		First  int // want "^unexported-naming: the symbol First is local, its name should start with a lowercase letter$"
		Second int
	)
	_, _ = First, Second

	f := func(Arg int) (Res int) { // want "^unexported-naming: the symbol Arg is local, its name should start with a lowercase letter$" "^unexported-naming: the symbol Res is local, its name should start with a lowercase letter$"
		Inner, inner := 1, 2 // want "^unexported-naming: the symbol Inner is local, its name should start with a lowercase letter$"
		return Inner + inner + Arg
	}
	_ = f

	return
}
