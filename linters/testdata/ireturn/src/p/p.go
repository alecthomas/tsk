package p

import "io"

type Doer interface{ Do() }

type impl struct{}

func (impl) Do() {}

func NewDoer() Doer { return impl{} } // want `^NewDoer returns interface \(p.Doer\)$`

func Concrete() impl { return impl{} }

func Reader() io.Reader { return nil }

func Err() error { return nil }

func Empty() any { return nil }

func Generic[T interface{ ~int | ~string }]() T { // want `^Generic returns generic interface \(T\) of type param ~int \| ~string$`
	var zero T
	return zero
}
