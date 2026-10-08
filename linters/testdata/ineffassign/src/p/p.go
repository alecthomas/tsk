// Adapted from github.com/gordonklaus/ineffassign's tests, MIT License.
package p

var b bool

func _() {
	var x int
	x = 0
	if b {
		_ = x
	}
}

func _() {
	var x int
	_ = x
	x = 0 // want "^ineffectual assignment to x$"
}

func _() {
	var x int
	x = 0 // want "ineffectual assignment to x"
	x = 0
	_ = x
}

func _() {
	x := false
	x = true
	_ = x
}

func _() {
	x := 1 // want "ineffectual assignment to x"
	x = 0
	_ = x
}

func _() {
	x := 0
	x += 0
	_ = x
}

func _() {
	x := 0
	for i := 0; i < 3; i++ {
		x = i
	}
	_ = x
}

func _() {
	x := 0
	for range 3 {
		x = 1 // want "ineffectual assignment to x"
		x = 2
		_ = x
	}
}

func _() {
	x := 0
	switch {
	case b:
		x = 1 // want "ineffectual assignment to x"
	default:
		x = 2 // want "ineffectual assignment to x"
	}
}

func _() int {
	x := 0
	switch {
	case b:
		x = 1
	default:
		x = 2
	}
	return x
}

func _() {
	x := 0
	f := func() { _ = x }
	x = 1
	f()
}

func _() {
	x := 0
	p := &x
	x = 1
	_ = p
}

func _() (err error) {
	defer func() { recover() }()
	err = nil
	panic("recovered with err set")
}
