//go:build go1.22

package forstmt

import "sync"

func ReportAssign(l []int) {
	// Test we do not report a duplicate if the assignment is reported.
	var mu sync.Mutex
	for x, mu := 0, mu; x < 10; x++ { // want "assignment copies lock value to mu: sync.Mutex"
		_ = mu.TryLock()
	}
}
