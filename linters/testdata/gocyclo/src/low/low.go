// Adapted from github.com/fzipp/gocyclo's tests, BSD license.
package low

var ch chan struct{}

func simple() {}

func cases(n int) { // want "^cyclomatic complexity 3 of func `cases` is high \\(> 1\\)$"
	switch n {
	case 1, 2:
	case 3:
	default:
	}
}

func comms() { // want "^cyclomatic complexity 2 of func `comms` is high \\(> 1\\)$"
	select {
	case <-ch:
	default:
	}
}

func loops(xs []int) { // want "^cyclomatic complexity 4 of func `loops` is high \\(> 1\\)$"
	for range xs {
	}
	for i := 0; i < 1; i++ {
		if i > 0 {
		}
	}
}

func operators(a, b, c bool) bool { // want "^cyclomatic complexity 3 of func `operators` is high \\(> 1\\)$"
	return a && b || c
}

// Function literals inside a function count towards it.
func literal(a bool) { // want "^cyclomatic complexity 2 of func `literal` is high \\(> 1\\)$"
	_ = func() {
		if a {
		}
	}
}

type T[K any] struct{}

func (T[K]) value(a bool) { // want "^cyclomatic complexity 2 of func `\\(T\\).value` is high \\(> 1\\)$"
	if a {
	}
}

func (*T[K]) pointer(a bool) { // want "^cyclomatic complexity 2 of func `\\(\\*T\\).pointer` is high \\(> 1\\)$"
	if a {
	}
}

// Function literals in declarations are named after the first name.
var first, second = func(a bool) { // want "^cyclomatic complexity 2 of func `first` is high \\(> 1\\)$"
	if a {
	}
}, 1

//gocyclo:ignore
func ignored(a bool) {
	if a {
	}
}
