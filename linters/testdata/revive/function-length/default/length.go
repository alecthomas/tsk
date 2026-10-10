// Adapted from github.com/mgechev/revive's tests, MIT License.
package lengthdefault

func funLengthA() { // want "^function-length: maximum number of statements per function exceeded; max 50 but got 51$"
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
	println()
}

type Message struct{}

func funLengthB(a, b, c, d int, list []any) []Message { // want "^function-length: maximum number of lines per function exceeded; max 75 but got 76$"
	if true {
		a = b
		if false {
			c = d
			for _, f := range list {
				_, ok := f.(int64)
				if !ok {
					continue
				}
			}
		}
	}
	if true {
		a = b
		if false {
			c = d
			for _, f := range list {
				_, ok := f.(int64)
				if !ok {
					continue
				}
			}
			switch a {
			case 1:
				println()
			case 2:
				println()
				println()
			default:
				println()

			}
		}
	}
	if true {
		a = b
		if false {
			c = d
			for _, f := range list {
				_, ok := f.(int64)
				if !ok {
					continue
				}
			}
			switch a {
			case 1:
				println()
			case 2:
				println()
				println()
			default:
				println()

			}
		}
	}
	if true {
		a = b
		if false {
			c = d
			for _, f := range list {
				_, ok := f.(int64)
				if !ok {
					continue
				}
			}
			switch a {
			case 1:
				println()
			default:
				println()

			}
		}
	}
	return nil
}
