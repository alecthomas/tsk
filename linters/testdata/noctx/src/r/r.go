package r

import "q"

// r does not import net/http itself, which upstream needs to see this call.
func _() {
	_, _ = q.Client().Get("https://example.com") // want `\(\*net/http\.Client\)\.Get must not be called`
}
