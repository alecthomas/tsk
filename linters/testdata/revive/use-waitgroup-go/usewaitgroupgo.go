// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package usewaitgroupgo tests use-waitgroup-go.
package usewaitgroupgo

import (
	"sync"
	"sync/atomic"
)

func doSomething() {}

func parseFile(filename string) (int, error) { return len(filename), nil }

func useWaitGroupGo(filenames []string, count int) {
	wg := sync.WaitGroup{}

	wg.Add(1) // want "^use-waitgroup-go: replace wg.Add\\(\\)...go {...wg.Done\\(\\)...} with wg.Go\\(...\\)$"
	go func() {
		defer wg.Done()
		doSomething()
	}()

	wg.Add(1) // want "^use-waitgroup-go: replace wg.Add\\(\\)...go {...wg.Done\\(\\)...} with wg.Go\\(...\\)$"
	go func() {
		doSomething()
		wg.Done()
	}()

	// from golang.org/x/tools/go/packages/packages.go/parseFiles
	parsed := make([]int, len(filenames))
	errors := make([]error, len(filenames))
	for i, file := range filenames {
		wg.Add(1) // want "^use-waitgroup-go: replace wg.Add\\(\\)...go {...wg.Done\\(\\)...} with wg.Go\\(...\\)$"
		go func(i int, filename string) {
			parsed[i], errors[i] = parseFile(filename)
			wg.Done()
		}(i, file)
	}
	wg.Wait()

	// from kubernetes/pkg/kubelet/cm/devicemanager/manager_test.go/TestGetTopologyHintsWithUpdates
	// notice the rule spots a wg.Add(2) (vs wg.Add(1)) therefore using wg.Go is possible but requires
	// replacing the wg.Add and the next two go statements with two wg.Go
	var updated atomic.Bool

	wg.Add(2) // want "^use-waitgroup-go: replace wg.Add\\(\\)...go {...wg.Done\\(\\)...} with wg.Go\\(...\\)$"

	go func() {
		defer wg.Done()
		for i := 0; i < count; i++ {
			doSomething()
		}
		updated.Store(true)
	}()
	go func() {
		defer wg.Done()
		for !updated.Load() {
			doSomething()
		}
	}()
	wg.Wait()
}

// from https://github.com/kubernetes-sigs/kueue/blob/4f2d0d2ef10c634daa4766be5f308fe2cda7503a/cmd/importer/util/util.go#L260
func concurrentJobs(jobs uint) {
	wg := sync.WaitGroup{}

	wg.Add(int(jobs)) // want "^use-waitgroup-go: replace wg.Add\\(\\)...go {...wg.Done\\(\\)...} with wg.Go\\(...\\)$"

	for range int(jobs) {
		go func() {
			defer wg.Done()
			doSomething()
		}()
	}

	wg.Wait()
}

func notWg() {
	group := sync.WaitGroup{}
	group.Add(1)
	go func() {
		defer group.Done()
	}()
	group.Wait()
}
