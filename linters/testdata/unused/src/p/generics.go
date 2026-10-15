package p

// A generic type's methods implement a generic interface when their type
// parameters unify, but not when a parameter would have to contain itself.
type getter[U any] interface{ get(U) U }

type wrapper[U any] interface{ wrap(U) holder[U] }

type picker[U any] interface {
	pick(U) interface{ get() U }
}

type holder[T any] struct{ V T }

type box[T any] struct{}

func (box[T]) get(v T) T { return v }

func (box[T]) wrap(v T) T { return v } // want `^func box\[T\].wrap is unused$`

func (box[T]) pick(v T) T { return v }

var (
	_ getter[int]  = box[int]{}
	_ wrapper[int] = nil
	_ picker[int]  = nil
	_              = holder[int]{}
)
