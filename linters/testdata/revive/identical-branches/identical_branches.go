// Adapted from github.com/mgechev/revive's tests, MIT License.
package identicalbranches

func identicalBranches() {
	if true { // want `^identical-branches: both branches of the if are identical$`

	} else {

	}

	if true {

	}

	if true {
		print()
	} else {
	}

	if true { // want `^identical-branches: both branches of the if are identical$`
		print()
	} else {
		print()
	}

	if true {
		if true { // want `^identical-branches: both branches of the if are identical$`
			print()
		} else {
			print()
		}
	} else {
		println()
	}

	if true {
		println("something")
	} else {
		println("else")
	}
}
