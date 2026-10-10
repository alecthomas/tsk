// Adapted from github.com/mgechev/revive's tests, MIT License.

// Test that we don't ask for comments on sort.Interface methods.

// Package pkg ...
package pkg

// T is ...
type T []int

// Len by itself should get documented.

func (t T) Len() int { return len(t) } // want "^exported: exported method T.Len should have comment or be unexported$"

// U is ...
type U []int

func (u U) Len() int           { return len(u) }
func (u U) Less(i, j int) bool { return u[i] < u[j] }
func (u U) Swap(i, j int)      { u[i], u[j] = u[j], u[i] }

func (u U) Other() {} // want "^exported: exported method U.Other should have comment or be unexported$"

// V is ...
type V []int

func (v V) Len() (result int)               { return len(v) }
func (v V) Less(i int, j int) (result bool) { return v[i] < v[j] }
func (v V) Swap(i int, j int)               { v[i], v[j] = v[j], v[i] }

// W is ...
type W []int

func (w W) Swap(i int, j int) {} // want "^exported: exported method W.Swap should have comment or be unexported$"

// Vv is ...
type Vv []int

func (vv Vv) Len() (result int)               { return len(vv) }       // want "^exported: exported method Vv.Len should have comment or be unexported$"
func (vv Vv) Less(i int, j int) (result bool) { return vv[i] < vv[j] } // want "^exported: exported method Vv.Less should have comment or be unexported$"

// X is ...
type X []int

func (x X) Less(i *int) (result bool) { return len(x) > *i } // want "^exported: exported method X.Less should have comment or be unexported$"

type synchronized1[T any] struct{}
type synchronized2[T any] struct{}
type synchronized3[T any] struct{}
type synchronized4[T any] struct{}

// Synchronized is a generic interface.
type Synchronized[T any] interface{}

// Test for issue #1217
func (s *synchronized1[T]) Swap(other Synchronized[T]) {}

// Swap for issue #1228
func (s *synchronized2[T]) Swap(other interface{}) {}

// Swap for issue #1228
func (s *synchronized3[T]) Swap(other []int) {}

// Swap for issue #1228
func (s *synchronized4[T]) Swap(other []interface{}) {}
