package blanks

func four() (int, int, int, int) { return 1, 2, 3, 4 }

func three() (int, int, int) { return 1, 2, 3 }

func f() {
	a, _, _, _ := four() // want "^declaration has 3 blank identifiers$"
	_, _, _ = three()    // want "^declaration has 3 blank identifiers$"
	b, _, _ := three()
	_, _ = a, b

	// Only a function body's own statements are checked.
	if true {
		_, _, _ = three()
	}
	g := func() {
		_, _, _ = three()
	}
	g()
}
