package options

type T struct{}

func (t T) Method() int { // want `^parameter name 't' is too short for the scope of its usage$`
	_ = 1
	_ = 2
	_ = 3
	_ = 4
	_ = 5
	return len(t.String())
}

func (T) String() string { return "" }

func ignored() int {
	i := 1
	i++
	i++
	i++
	i++
	i++
	return i
}
