//go:build go1.21

package forstmt

import "sync"

func InGo21(l []int) {
	var mu sync.Mutex
	var x int

	for x, mu = 0, (sync.Mutex{}); x < 10; x++ {   // Not reported on '='.
	}
	for x, mu := 0, (sync.Mutex{}); x < 10; x++ {  // Not reported before 1.22.
		_ = mu.TryLock()
	}
	for x, _ := 0, (sync.Mutex{}); x < 10; x++ {  // Not reported due to '_'.
		_ = mu.TryLock()
	}
	for _, mu := 0, (sync.Mutex{}); x < 10; x++ { // Not reported before 1.22.
		_ = mu.TryLock()
	}
}
