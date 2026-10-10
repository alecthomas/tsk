// Adapted from github.com/mgechev/revive's tests, MIT License.
package identicalswitchbranchesdefault

func identicalSwitchBranches() {
	switch a { // want `^identical-switch-branches: "switch" with identical branches \(lines 7 and 11\)$`
	// expected values
	case 1:
		foo()
	case 2:
		bar()
	case 3:
		foo()
	default:
		return newError("blah")
	}

	// Reported below: "switch" with identical branches (lines 21 and 25)
	// Reported below: "switch" with identical branches (lines 23 and 27)
	switch a { // want `^identical-switch-branches: "switch" with identical branches \(lines 21 and 25\)$` `^identical-switch-branches: "switch" with identical branches \(lines 23 and 27\)$`
	// expected values
	case 1:
		foo()
	case 2:
		bar()
	case 3:
		foo()
	default:
		bar()
	}

	switch a { // want `^identical-switch-branches: "switch" with identical branches \(lines 33 and 35\)$`
	// expected values
	case 1:
		foo()
	case 3:
		foo()
	default:

	}

	// Skip untagged switch
	switch {
	case a > b:
		foo()
	default:
		foo()
	}

	// Do not warn on fallthrough

	switch a {
	case 1:
		foo()
		fallthrough
	case 2:
		fallthrough
	case 3:
		foo()
	case 4:
		fallthrough
	default:
		bar()
	}

	// skip type switch
	switch v := value.(type) {
	case int:
		println("dup", v)
	case string:
		println("dup", v)
	case bool:
		println("dup", v)
	case float64:
		println("dup", v)
	default:
		println("dup", v)
	}
}
