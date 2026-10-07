package factorynarrow

type Target struct { // want Target:`encapsulated \{"directConstructor":true,"generated":false,"module":""\}`
	private int
	next    *Target
}

func (t *Target) Value() int { return t.private }

type Value interface{ Value() int }

type Factory struct{}

func (Factory) Direct() *Target { return &Target{} }

func (Factory) FromVariable() *Target {
	target := &Target{private: 1}
	return target
}

func (Factory) FromNew() (*Target, error) { return new(Target), nil }

func (Factory) AsInterface() Value { return Value(&Target{}) }

func (Factory) NamedResult() (target *Target) {
	target = &Target{}
	return
}

func (Factory) Unreturned() *Target {
	_ = &Target{} // want "encapsulated struct example/factorynarrow.Target may only be constructed"
	return nil
}

func (Factory) Nested() *Target {
	return &Target{
		next: &Target{}, // want "encapsulated struct example/factorynarrow.Target may only be constructed"
	}
}

func (Factory) Overwritten() *Target {
	target := &Target{} // want "encapsulated struct example/factorynarrow.Target may only be constructed"
	target = &Target{}  // want "encapsulated struct example/factorynarrow.Target may only be constructed"
	return target
}

func (Factory) ReadOther(target *Target) int {
	return target.private // want "private field example/factorynarrow.Target.private may only be accessed"
}

type OtherFactory struct{}

func (OtherFactory) Make() *Target {
	return &Target{} // want "encapsulated struct example/factorynarrow.Target may only be constructed"
}

type Parent struct{ Child *Target }

func NewParent() *Parent {
	return &Parent{
		Child: &Target{}, // want "encapsulated struct example/factorynarrow.Target may only be constructed"
	}
}
