package engine

import (
	"log/slog"
	"runtime"
	"sync"
	"time"

	"github.com/alecthomas/errors"

	"github.com/alecthomas/tsk/internal/vm"
)

// buffer is how many runtimes the pool keeps idle or being created, so a run
// rarely waits for one to be created.
const buffer = 2

// pool lends runtimes to concurrent analyzer runs, up to one per CPU. It keeps
// a buffer of runtimes created in the background, because creating one
// evaluates every module.
type pool struct {
	modules *vm.Modules
	logger  *slog.Logger
	limit   int
	lock    sync.Mutex
	ready   *sync.Cond
	idle    []*vm.Runtime
	// created counts runtimes that exist or are being created; creating
	// counts those being created in the background.
	created  int
	creating int
}

func newPool(modules *vm.Modules, logger *slog.Logger) *pool {
	p := &pool{modules: modules, logger: logger, limit: runtime.GOMAXPROCS(0)}
	p.ready = sync.NewCond(&p.lock)
	return p
}

func (p *pool) get() (*vm.Runtime, error) {
	p.lock.Lock()
	// A run waits for a runtime being created rather than creating another.
	for len(p.idle) == 0 && (p.creating > 0 || p.created >= p.limit) {
		p.ready.Wait()
	}
	if n := len(p.idle); n > 0 {
		runtime := p.idle[n-1]
		p.idle = p.idle[:n-1]
		p.refill()
		p.lock.Unlock()
		return runtime, nil
	}
	p.created++
	p.lock.Unlock()
	start := time.Now()
	runtime, err := vm.New(p.modules, p.logger)
	if err != nil {
		p.lock.Lock()
		p.created--
		p.ready.Broadcast()
		p.lock.Unlock()
		return nil, errors.Wrap(err, "create runtime")
	}
	p.logger.Debug("Created runtime", "duration", time.Since(start))
	return runtime, nil
}

// put returns a runtime. The bootstrap runtime joins the pool this way too.
func (p *pool) put(runtime *vm.Runtime) {
	p.lock.Lock()
	defer p.lock.Unlock()
	p.idle = append(p.idle, runtime)
	if p.created < len(p.idle) {
		p.created = len(p.idle)
	}
	p.ready.Signal()
}

// warm fills the buffer in the background, overlapping package loading.
func (p *pool) warm() {
	p.lock.Lock()
	defer p.lock.Unlock()
	p.refill()
}

// refill starts background creations until idle and in-progress runtimes
// reach the buffer, within the limit. The caller holds the lock.
//
// The goroutines are not joined: each finishes by adding its runtime to the
// pool, and an exiting process does not need to wait for them.
func (p *pool) refill() {
	for len(p.idle)+p.creating < buffer && p.created < p.limit {
		p.created++
		p.creating++
		go p.createInBackground()
	}
}

// createInBackground creates a runtime for the buffer. A failure is only
// logged: the next run without an idle runtime creates one itself and
// reports the error.
func (p *pool) createInBackground() {
	start := time.Now()
	runtime, err := vm.New(p.modules, p.logger)
	p.lock.Lock()
	defer p.lock.Unlock()
	p.creating--
	if err != nil {
		p.created--
		p.logger.Debug("Background runtime creation failed", "error", err)
	} else {
		p.idle = append(p.idle, runtime)
		p.logger.Debug("Created runtime", "duration", time.Since(start), "background", true)
	}
	// Waiters may be waiting on this creation, so all re-check.
	p.ready.Broadcast()
}
