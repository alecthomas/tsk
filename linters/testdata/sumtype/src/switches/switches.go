package switches

//sumtype:decl
type T interface{ sealed() } // want T:`sumType \{"variants":\["A","B","C"\]\}`

type A struct{}

func (*A) sealed() {}

type B struct{}

func (*B) sealed() {}

// C implements T with a value receiver.
type C struct{}

func (C) sealed() {}

type Alias = A

type Generic[E any] struct{}

func (*Generic[E]) sealed() {}

type Other interface{ other() }

func missingOne(t T) {
	switch t.(type) { // want `exhaustiveness check failed for sum type "T" \(from .*switches.go:4:6\): missing cases for C$`
	case *A, *B:
	}
}

func missingTwo(t T) {
	switch v := t.(type) { // want `missing cases for B, C$`
	case *A:
		_ = v
	}
}

func complete(t T) {
	switch t.(type) {
	case *A, *B:
	case C:
	}
}

func viaAlias(t T) {
	switch t.(type) {
	case *Alias, *B, C:
	}
}

func defaultCase(t T) {
	switch t.(type) {
	case *A:
	default:
	}
}

func panickingDefault(t T) {
	switch t.(type) { // want `missing cases for B, C$`
	case *A:
	default:
		panic("unreachable")
	}
}

func notSumType(o Other) {
	switch o.(type) {
	case nil:
	}
}
