package pointers

import "context"

type holder struct {
	ctx context.Context
}

func structPointer(h *holder) {
	func() {
		h.ctx = context.WithValue(h.ctx, "key", 1) // want "^potential nested context in struct pointer$"
	}()
}
