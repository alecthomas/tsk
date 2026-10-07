package factoryconsumer

import "example/factorynarrow"

type Parent struct{ Child *factorynarrow.Target }

func NewParent() *Parent {
	return &Parent{
		Child: &factorynarrow.Target{}, // want "encapsulated struct example/factorynarrow.Target may only be constructed"
	}
}
