package forstmt

import "sync"

func InGo22ByModuleVersion(l []int) {
	var mu sync.Mutex
	var x int

	for x, mu = 0, (sync.Mutex{}); x < 10; x++ {  // Not reported on '='.
	}
	for x, mu := 0, (sync.Mutex{}); x < 10; x++ { // want "for loop iteration copies lock value to mu: sync.Mutex"
		_ = mu.TryLock()
	}
	for x, _ := 0, (sync.Mutex{}); x < 10; x++ {  // Not reported due to '_'.
		_ = mu.TryLock()
	}
	for _, mu := 0, (sync.Mutex{}); x < 10; x++ { // want "for loop iteration copies lock value to mu: sync.Mutex"
		_ = mu.TryLock()
	}
}
