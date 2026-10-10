// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package atomic tests atomic.
package atomic

import (
	"sync/atomic"
)

type Counter uint64

func AtomicTests() {
	x := uint64(1)
	x = atomic.AddUint64(&x, 1)        // want "^atomic: direct assignment to atomic value$"
	_, x = 10, atomic.AddUint64(&x, 1) // want "^atomic: direct assignment to atomic value$"
	x, _ = atomic.AddUint64(&x, 1), 10 // want "^atomic: direct assignment to atomic value$"

	y := &x
	*y = atomic.AddUint64(y, 1) // want "^atomic: direct assignment to atomic value$"

	var su struct{ Counter uint64 }
	su.Counter = atomic.AddUint64(&su.Counter, 1) // want "^atomic: direct assignment to atomic value$"
	z1 := atomic.AddUint64(&su.Counter, 1)
	_ = z1

	var sp struct{ Counter *uint64 }
	*sp.Counter = atomic.AddUint64(sp.Counter, 1) // want "^atomic: direct assignment to atomic value$"
	z2 := atomic.AddUint64(sp.Counter, 1)
	_ = z2

	au := []uint64{10, 20}
	au[0] = atomic.AddUint64(&au[0], 1) // want "^atomic: direct assignment to atomic value$"
	au[1] = atomic.AddUint64(&au[0], 1)

	ap := []*uint64{&au[0], &au[1]}
	*ap[0] = atomic.AddUint64(ap[0], 1) // want "^atomic: direct assignment to atomic value$"
	*ap[1] = atomic.AddUint64(ap[0], 1)
}

type T struct{}

func (T) AddUint64(addr *uint64, delta uint64) uint64 { return 0 }

// Revive flags this only when no other rule has type-checked the package.
func NonAtomic() {
	x := uint64(1)
	var atomic T
	x = atomic.AddUint64(&x, 1)
}
