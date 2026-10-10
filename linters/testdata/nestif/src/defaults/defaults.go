package defaults

func below(b1, b2, b3 bool) {
	if b1 {
		if b2 {
			if b3 {
			}
		}
	}
}

func at(b1, b2, b3, b4 bool) {
	if b1 { // want "^`if b1` has complex nested blocks \\(complexity: 6\\)$"
		if b2 {
			if b3 {
				if b4 {
				}
			}
		}
	}
}
