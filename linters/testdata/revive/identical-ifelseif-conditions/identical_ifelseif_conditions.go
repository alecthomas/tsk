// Adapted from github.com/mgechev/revive's tests, MIT License.
package identicalifelseifconditions

func identicalBranches() {
	// no failure for nested ifs
	if true {
		if true {
		}
	} else {
		if true {
		}
	}

	// single failure
	if a > 0 {
		print("something")
	} else if a < 0 {
		print("something else")
	} else if a == 0 {
		print("other thing")
	} else if a > 0 { // want `^identical-ifelseif-conditions: "if\.\.\.else if" chain with identical conditions \(lines 15 and 21\)$`
		println()
	} else {
		print("something")
	}

	// multiple failures in the same if...else if chain
	if a > 0 {
		print("something")
	} else if a < 0 {
		print("something else")
	} else if a == 0 {
		print("other thing")
	} else if a > 0 { // want `^identical-ifelseif-conditions: "if\.\.\.else if" chain with identical conditions \(lines 28 and 34\)$`
		println()
	} else if a == 0 { // want `^identical-ifelseif-conditions: "if\.\.\.else if" chain with identical conditions \(lines 32 and 36\)$`
		print("other thing")
	} else {
		print("something")
	}

	// failures in nested if...else if
	if true {
		if false {
		} else if false { // want `^identical-ifelseif-conditions: "if\.\.\.else if" chain with identical conditions \(lines 44 and 45\)$`
		}
	} else if foo() {

	} else {
		if false {
		} else if false { // want `^identical-ifelseif-conditions: "if\.\.\.else if" chain with identical conditions \(lines 50 and 51\)$`
		}
	}
}
