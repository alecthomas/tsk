// Adapted from github.com/mgechev/revive's tests, MIT License.
package nested

type Foo struct {
	Bar struct { // want "^nested-structs: no nested structs are allowed$"
		Baz struct { // want "^nested-structs: no nested structs are allowed$"
			b   bool
			Qux struct { // want "^nested-structs: no nested structs are allowed$"
				b bool
			}
		}
	}
}

type Quux struct {
	Quuz Quuz
}

type Quuz struct {
}

type Quiz struct {
	s struct{} // want "^nested-structs: no nested structs are allowed$"
}

type nestedStructInChan struct {
	c chan struct {
		a int
		b struct{ c int } // want "^nested-structs: no nested structs are allowed$"
	}
}

func waldo() (s struct{ b bool }) { return s }

func fred() interface{} {
	s := struct {
		b bool
		t struct { // want "^nested-structs: no nested structs are allowed$"
			b bool
		}
	}{}

	return s
}

// issue 664
type Bad struct {
	Field []struct{} // want "^nested-structs: no nested structs are allowed$"
}

// issue744
type issue744 struct {
	c chan struct{}
}

// issue 781
type mySetInterface interface {
	GetSet() map[string]struct{}
}

// issue 824
type test struct {
	foo []chan struct{}     // Must not match
	bar map[string]struct{} // Must not match
}
