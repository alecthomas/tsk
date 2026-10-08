package order

// Methods in another file than their type are not checked.
func (t *Thing) another() {}

func (t *Thing) Another() {}
