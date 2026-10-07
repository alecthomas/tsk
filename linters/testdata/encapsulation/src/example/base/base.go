package base

type Widget struct { // want Widget:`encapsulated \{"directConstructor":true,"generated":false,"module":""\}`
	private int
	Public  int
	sibling *Widget
}

func (w *Widget) Value() int { return w.private }

func (w *Widget) rebuild() *Widget {
	return &Widget{} // want "encapsulated struct example/base.Widget may only be constructed"
}

type Value interface{ Value() int }

func NewWidget() *Widget { return &Widget{private: 1} }
func Widgetf() Widget    { return Widget{} }
func MakeWidget() Value  { return &Widget{} }
func New() *Widget       { return new(Widget) }

func helper(w *Widget) {
	_ = w.private // want "private field example/base.Widget.private may only be accessed"
	_ = w.Public
	_ = Widget{}    // want "encapsulated struct example/base.Widget may only be constructed"
	_ = new(Widget) // want "encapsulated struct example/base.Widget may only be constructed"
}

type Option func(*Widget)

func WithPrivate(v int, other *Widget) Option {
	return func(target *Widget) {
		target.private = v
		other.private = v // want "private field example/base.Widget.private may only be accessed"
		alias := target
		alias.private = v          // want "private field example/base.Widget.private may only be accessed"
		target.sibling.private = v // want "private field example/base.Widget.private may only be accessed"
	}
}

func WithConverted(v int) Option {
	return Option(func(target *Widget) { target.private = v })
}

type OptionInterface interface{ Apply(*Widget) error }
type OptionFunc func(*Widget) error

func (option OptionFunc) Apply(target *Widget) error { return option(target) }

func WithInterface(v int, other *Widget) OptionInterface {
	return OptionFunc(func(target *Widget) error {
		target.private = v
		other.private = v // want "private field example/base.Widget.private may only be accessed"
		return nil
	})
}

func WithIndirect(v int) Option {
	option := func(target *Widget) { target.private = v } // want "private field example/base.Widget.private may only be accessed"
	return option
}

type internal struct{ private int }

func plain() {
	v := internal{private: 1}
	_ = v.private
}

type guarded struct{ private int }

func (*guarded) Touch() {}

func NewGuarded() *guarded { return new(guarded) }

func bypass(g *guarded) {
	_ = g.private // want "private field example/base.guarded.private may only be accessed"
	_ = guarded{} // want "encapsulated struct example/base.guarded may only be constructed"
}

type HTTPServer struct{ private int } // want HTTPServer:`encapsulated \{"directConstructor":true,"generated":false,"module":""\}`

func NewHttpServer() *HTTPServer { return &HTTPServer{} }

func Trace() *HTTPServer {
	server := &HTTPServer{private: 1}
	_ = server.private
	return server
}

func WrongWidget() *HTTPServer {
	_ = Widget{} // want "encapsulated struct example/base.Widget may only be constructed"
	return &HTTPServer{}
}

type Box[T any] struct{ value T } // want Box:`encapsulated \{"directConstructor":true,"generated":false,"module":""\}`

func (b *Box[T]) Get() T { return b.value }

func NewBox[T any](value T) *Box[T] { return &Box[T]{value: value} }

func useBox(b *Box[int]) {
	_ = b.value       // want "private field example/base.Box.value may only be accessed"
	_ = Box[int]{}    // want "encapsulated struct example/base.Box may only be constructed"
	_ = new(Box[int]) // want "encapsulated struct example/base.Box may only be constructed"
}

type Outer struct{ *Widget }

func (o *Outer) misuse() {
	_ = o.private // want "private field example/base.Widget.private may only be accessed"
}

func usePromoted(o *Outer) {
	_ = o.private // want "private field example/base.Widget.private may only be accessed"
}

type EmbeddedState struct{ private int } // want EmbeddedState:`encapsulated \{"directConstructor":false,"generated":false,"module":""\}`

func (s EmbeddedState) Current() int { return s.private }

type EmbeddedOwner struct{ EmbeddedState }

func NewEmbeddedOwner() *EmbeddedOwner { return &EmbeddedOwner{} }

func (o *EmbeddedOwner) update(state EmbeddedState) {
	o.private++
	o.EmbeddedState.private++
	_ = state.private // want "private field example/base.EmbeddedState.private may only be accessed"
}

func useEmbeddedOwner(o *EmbeddedOwner) {
	_ = o.private               // want "private field example/base.EmbeddedState.private may only be accessed"
	_ = o.EmbeddedState.private // want "private field example/base.EmbeddedState.private may only be accessed"
}

type Alias = Widget

func useAlias() {
	_ = Alias{} // want "encapsulated struct example/base.Widget may only be constructed"
}

type Child struct{ hidden int }       // want Child:`encapsulated \{"directConstructor":false,"generated":false,"module":""\}`
type DirectChild struct{ hidden int } // want DirectChild:`encapsulated \{"directConstructor":true,"generated":false,"module":""\}`

func Arbitrary() any { return nil }

type Parent struct {
	Children []*Child
	One      *Child
	Direct   *DirectChild
	Other    any
}

func Assemble() *Parent {
	_ = &Child{} // want "encapsulated struct example/base.Child may only be constructed"
	_ = Parent{nil, &Child{}, nil, nil}
	return &Parent{
		Children: []*Child{{hidden: 1}},
		One:      new(Child),
		Direct:   &DirectChild{}, // want "encapsulated struct example/base.DirectChild may only be constructed"
		Other:    &Child{},       // want "encapsulated struct example/base.Child may only be constructed"
	}
}

// This appears after Assemble to verify that declaration order does not matter.
func BuildDirectChild() *DirectChild { return &DirectChild{} }

func UseChild() {
	_ = Child{}               // want "encapsulated struct example/base.Child may only be constructed"
	_ = Parent{One: &Child{}} // want "encapsulated struct example/base.Child may only be constructed"
}
