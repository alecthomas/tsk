package consumer

import (
	"example/base"
	"example/generated"
	"reflect"
)

func use() {
	_ = base.Widget{}          // want "encapsulated struct example/base.Widget may only be constructed"
	_ = new(base.Widget)       // want "encapsulated struct example/base.Widget may only be constructed"
	_ = base.Widget{Public: 1} // want "encapsulated struct example/base.Widget may only be constructed"
	_ = reflect.Value{}
	_ = new(reflect.Value)
	_ = base.NewWidget()
	_ = base.Widgetf()
	_ = base.Child{} // want "encapsulated struct example/base.Child may only be constructed"
	_ = generated.Message{} // want "encapsulated struct example/generated.Message may only be constructed"
}

type Container struct {
	Child  *base.Child
	Widget *base.Widget
}

func MakeContainer() *Container {
	return &Container{
		Child:  &base.Child{},
		Widget: &base.Widget{}, // want "encapsulated struct example/base.Widget may only be constructed"
	}
}
