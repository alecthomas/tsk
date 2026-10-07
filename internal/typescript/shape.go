package typescript

// Shape describes a JSON-like TypeScript type.
type Shape interface{ shape() }

// StringShape is string.
type StringShape struct{}

// NumberShape is number.
type NumberShape struct{}

// BooleanShape is boolean.
type BooleanShape struct{}

// EnumShape is a union of string literals, with Values sorted.
type EnumShape struct{ Values []string }

// ArrayShape is an array of Element.
type ArrayShape struct{ Element Shape }

// RecordShape is an object with arbitrary string keys and Element values.
type RecordShape struct{ Element Shape }

// ObjectShape is an object with known properties, in declaration order.
type ObjectShape struct{ Properties []Property }

// Property is one known property of an ObjectShape.
type Property struct {
	Name     string
	Optional bool
	Shape    Shape
	// Doc is the property's JSDoc comment as plain text, or "".
	Doc string
}

func (StringShape) shape()  {}
func (NumberShape) shape()  {}
func (BooleanShape) shape() {}
func (EnumShape) shape()    {}
func (ArrayShape) shape()   {}
func (RecordShape) shape()  {}
func (ObjectShape) shape()  {}
