// Adapted from github.com/ultraware/funlen's tests, MIT License.
package small

func lines() { // want `^Function 'lines' is too long \(3 > 2\)$`
	print("a")
	print("b")
	print("c")
}

func statements() { // want `^Function 'statements' has too many statements \(10 > 3\)$`
	print("Hello, world!")
	if true {
		y := []int{1, 2, 3, 4}
		for k, v := range y {
			f := func() { print("test", k, v) }
			f()
		}
	}
	switch {
	case true:
		print("x")
	}
}

func comments() {
	// Comment 1
	// Comment 2
	print("Hello, world!")
}

func deferred() { // want `^Function 'deferred' has too many statements \(4 > 3\)$`
	defer func() {
		print("a")
		print("b")
		print("c")
	}()
}
