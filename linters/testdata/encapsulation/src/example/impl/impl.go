package impl

import "example/iface"

type Item struct{ hidden int } // want Item:`encapsulated \{"directConstructor":false,"generated":false,"module":""\}`

func (*Item) Visit() {}

var _ iface.Node = (*Item)(nil)

func inspect(item *Item) { _ = item.hidden }

func other(item *Item) {
	_ = item.hidden // want "private field example/impl.Item.hidden may only be accessed"
}
