package average // want `^the average complexity for the package average is 2\.500000, max is 2\.000000$`

func one() {}

func four(a, b, c bool) {
	if a || b || c {
		return
	}
}
