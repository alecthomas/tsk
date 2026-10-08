// Adapted from go.augendre.info/fatcontext's tests, MIT License.
package nested

import (
	"context"
	"testing"
)

func loops(ctx context.Context) {
	for i := 0; i < 10; i++ {
		ctx = context.WithValue(ctx, "key", i) // want "^nested context in loop$"
	}

	for range 10 {
		ctx := context.WithValue(ctx, "key", 1)
		_ = ctx
	}

	for range 10 {
		if true {
			ctx = context.WithValue(ctx, "key", 1) // want "^nested context in loop$"
		}
	}

	for range 10 {
		ctx = context.Background()
		ctx = context.WithValue(ctx, "key", 1)
	}
}

func literals(ctx context.Context) {
	f := func() {
		ctx = context.WithValue(ctx, "key", 1) // want "^nested context in function literal$"
	}
	f()

	defer func() {
		ctx = context.WithValue(ctx, "key", 1)
	}()
}

func cleanup(t *testing.T) {
	ctx := t.Context()
	t.Cleanup(func() {
		ctx = context.WithValue(ctx, "key", 1)
	})
	for range 10 {
		ctx = t.Context()
		ctx = context.WithValue(ctx, "key", 1)
	}
}

type holder struct {
	ctx context.Context
}

func pointers(h *holder) {
	for range 10 {
		h.ctx = context.WithValue(h.ctx, "key", 1) // want "^nested context in loop$"
	}
	for range 10 {
		local := holder{}
		local.ctx = context.WithValue(local.ctx, "key", 1)
	}
}

func structPointer(h *holder) {
	func() {
		h.ctx = context.WithValue(h.ctx, "key", 1) // reported only with check-struct-pointers
	}()
}
