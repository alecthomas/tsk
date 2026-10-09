package options

func multiLine(
	a int,
) { // want `^multi-line statement should be followed by a newline$`
	_ = a
}

func multiLineSpaced(
	a int,
) {

	_ = a
}

func multiIf(a, b bool) {
	if a &&
		b { // want `^multi-line statement should be followed by a newline$`
		_ = 1
	}
	if a { // want `^unnecessary leading newline$`

		_ = 1
	}
}
