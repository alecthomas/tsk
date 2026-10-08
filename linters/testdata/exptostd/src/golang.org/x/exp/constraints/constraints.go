// Package constraints stubs golang.org/x/exp/constraints.
package constraints

type Ordered interface {
	~int | ~string
}

type Integer interface {
	~int
}
