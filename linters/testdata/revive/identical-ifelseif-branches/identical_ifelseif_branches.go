// Adapted from github.com/mgechev/revive's tests, MIT License.
package identicalifelseifbranches

func identicalIfElseIfBranches() {

	if true { // want `^identical-ifelseif-branches: "if\.\.\.else if" chain with identical branches \(lines 6 and 14\)$`
		print("something")
	} else if true {
		print("something else")
	} else if true {
		print("other thing")
	} else if false {
		println()
	} else {
		print("something")
	}

	if true { // want `^identical-ifelseif-branches: "if\.\.\.else if" chain with identical branches \(lines 18 and 24\)$`
		print("something")
	} else if true {
		print("something else")
	} else if true {
		print("other thing")
	} else if false {
		print("something")
	} else {
		println()
	}

	if true {
		print("something")
	} else if true {
		print("something else")
		if true { // want `^identical-ifelseif-branches: "if\.\.\.else if" chain with identical branches \(lines 34 and 36\)$`
			print("something")
		} else if false {
			print("something")
		} else {
			println()
		}
	}

	// Should not warn because even if branches are identical, the err variable is not
	if err := something(); err != nil {
		println(err)
	} else if err := somethingElse(); err != nil {
		println(err)
	}

	// Multiple identical pair of branches
	if a { // want `^identical-ifelseif-branches: "if\.\.\.else if" chain with identical branches \(lines 51 and 55\)$` `^identical-ifelseif-branches: "if\.\.\.else if" chain with identical branches \(lines 53 and 57\)$`
		foo()
	} else if b {
		bar()
	} else if c {
		foo()
	} else if d {
		bar()
	}
	// Reported below: "if...else if" chain with identical branches (lines 51 and 55)
	// Reported below: "if...else if" chain with identical branches (lines 53 and 57)

	if createFile() { // want `^identical-ifelseif-branches: "if\.\.\.else if" chain with identical branches \(lines 63 and 67\)$`
		doSomething()
	} else if !delete() {
		return new("cannot delete file")
	} else if createFile() {
		doSomething()
	} else {
		return new("file error")
	}

	// Test confidence is reset
	if a { // want `^identical-ifelseif-branches: "if\.\.\.else if" chain with identical branches \(lines 74 and 76\)$`
		foo()
	} else if b {
		foo()
	} else {
		bar()
	}
}
