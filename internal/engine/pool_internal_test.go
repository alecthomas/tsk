package engine

import (
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/alecthomas/assert/v2"

	"github.com/alecthomas/tsk/internal/vm"
)

func TestPoolServesUrgentRunsFirst(t *testing.T) {
	p := newPool(nil, slog.New(slog.DiscardHandler))
	p.limit = 1
	p.put(&vm.Runtime{})
	held, err := p.get(false)
	assert.NoError(t, err)
	served := make(chan bool, 2)
	var wg sync.WaitGroup
	// The ordinary run starts waiting first; the urgent run is still served
	// first.
	for i, urgent := range []bool{false, true} {
		wg.Go(func() {
			runtime, err := p.get(urgent)
			assert.NoError(t, err)
			served <- urgent
			p.put(runtime)
		})
		waitUntil(t, func() bool {
			p.lock.Lock()
			defer p.lock.Unlock()
			return p.waiting[0]+p.waiting[1] == i+1
		})
	}
	p.put(held)
	wg.Wait()
	close(served)
	var order []bool
	for urgent := range served {
		order = append(order, urgent)
	}
	assert.Equal(t, []bool{true, false}, order)
}

func waitUntil(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(time.Millisecond)
	}
}
