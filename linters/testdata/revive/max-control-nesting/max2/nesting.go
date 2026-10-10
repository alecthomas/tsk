// Adapted from github.com/mgechev/revive's tests, MIT License.
package max2

func mcn(c1, c2 chan int) {
	if true {
		if true {
			if true { // want "^max-control-nesting: control flow nesting exceeds 2$"

			}
		}
	} else {
		if true {
			if true { // want "^max-control-nesting: control flow nesting exceeds 2$"
				if true {

				}
			}
		}
	}

	for {
		if true {
			for { // want "^max-control-nesting: control flow nesting exceeds 2$"
			}
		}
	}
}

func mcnSwitch(c1, c2 chan int) {
	switch {
	case false:
		if true {

		}
	case true:
		if true {
			for { // want "^max-control-nesting: control flow nesting exceeds 2$"
			}
		}
	default:
	}

	select {
	case msg1 := <-c1:
		println("received", msg1)
	case msg2 := <-c2:
		println("received", msg2)
		if true {
			for { // want "^max-control-nesting: control flow nesting exceeds 2$"
			}
		}
	}
}

func mcnFuncLit() {
	if true {
		f1 := func() {
			if true {
				for {
				}
			}
		}
		_ = f1
	}

	f1 := func() {
		for {
			if true {
				for { // want "^max-control-nesting: control flow nesting exceeds 2$"
				}
			}
		}
	}
	_ = f1
}

// Range statements do not nest, as in revive.
func mcnRange(xs []int) {
	for range xs {
		for range xs {
			if true {
				if true {
				}
			}
		}
	}
}
