// Adapted from github.com/nakabonne/nestif's tests, BSD license.
package low

func flat(b1 bool) {
	if b1 {
	}
}

func nested(b1, b2, b3, b4 bool) {
	if b1 { // want "^`if b1` has complex nested blocks \\(complexity: 1\\)$"
		if b2 {
		}
	}

	if b1 { // want "^`if b1` has complex nested blocks \\(complexity: 9\\)$"
		if b2 {
			if b3 {
			}
		}

		if b2 {
			if b3 {
				if b4 {
				}
			}
		}
	}
}

func branches(b1, b2, b3, b4 bool) {
	if b1 { // want "^`if b1` has complex nested blocks \\(complexity: 4\\)$"
		if b2 {
		} else {
			if b3 {
			}
		}
	}

	if b1 { // want "^`if b1` has complex nested blocks \\(complexity: 4\\)$"
		if b2 {
		} else if b3 {
			if b4 {
			}
		}
	}
}

// Function literals outside an if hold their own roots; inside one, they
// add to it.
func literals(b1, b2 bool) {
	f := func() {
		if b1 { // want "^`if b1` has complex nested blocks \\(complexity: 1\\)$"
			if b2 {
			}
		}
	}
	f()

	if b1 { // want "^`if b1` has complex nested blocks \\(complexity: 3\\)$"
		g := func() {
			if b2 {
				if b1 {
				}
			}
		}
		g()
	}
}

// Conditions print without indentation; init statements are not counted.
func conditions(a, b, c bool) {
	if x := a; x && // want "^`if x &&\n\\(b \\|\\| c\\)` has complex nested blocks \\(complexity: 1\\)$"
		(b || c) {
		if b {
		}
	}
}
