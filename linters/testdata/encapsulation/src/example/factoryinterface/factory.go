package factoryinterface

import "example/iface"

type node interface{ Node() }

type first struct{ hidden int }

func (*first) Node() {}

type second struct{ hidden int }

func (*second) Node() {}

type imported struct{ hidden int }

func (*imported) Visit() {}

type unrelated struct{ hidden int }

func (*unrelated) Other() {}

type Maker struct{}

func (Maker) First() node { return &first{} }

func (Maker) Second() node {
	value := &second{}
	return value
}

func (Maker) Imported() iface.Node { return &imported{} }

func (Maker) Unreturned() node {
	_ = &first{} // want "encapsulated struct example/factoryinterface.first may only be constructed"
	return nil
}

func (Maker) Unrelated() *unrelated {
	return &unrelated{} // want "encapsulated struct example/factoryinterface.unrelated may only be constructed"
}

type OtherMaker struct{}

func (OtherMaker) First() node {
	return &first{} // want "encapsulated struct example/factoryinterface.first may only be constructed"
}
