package p

func leading() { // want `^unnecessary leading newline$`

	_ = 1
}

func trailing() {
	_ = 1

} // want `^unnecessary trailing newline$`

func nested() {
	if true { // want `^unnecessary leading newline$`

		_ = 1
	}
}

func comment() { /* a comment that continues
	onto later lines counts as content */

	_ = 1
}

func fine() {
	_ = 1
}

func multiLine(
	a int,
) {
	_ = a
}

func multiIf(a, b bool) {
	if a &&
		b {
		_ = 1
	}
}
