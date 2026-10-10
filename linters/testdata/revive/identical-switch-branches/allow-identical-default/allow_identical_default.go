// Adapted from github.com/mgechev/revive's tests, MIT License.
package identicalswitchbranchesallowidenticaldefault

func identicalSwitchBranchesAllowIdenticalDefault() {
	// The point of the option: a fallback that repeats a listed case is a
	// deliberate choice, so it must not be reported...
	switch a {
	case 1:
		foo()
	case 2:
		bar()
	default:
		foo()
	}

	// ...but identical *case* clauses are still reported, default or not.
	switch a { // want `^identical-switch-branches: "switch" with identical branches \(lines 18 and 22\)$`
	case 1:
		foo()
	case 2:
		bar()
	case 3:
		foo()
	default:
		bar()
	}

	// An empty default matching an empty case is still allowed.
	switch a {
	case 1:

	default:

	}

	// Nested switches inside an ignored default are still analyzed.
	switch a {
	case 1:
		foo()
	default:
		switch b { // want `^identical-switch-branches: "switch" with identical branches \(lines 42 and 44\)$`
		case 1:
			bar()
		case 2:
			bar()
		}
	}

	// Fallthrough handling is unchanged.
	switch a {
	case 1:
		foo()
		fallthrough
	case 2:
		bar()
	default:
		bar()
	}
}
