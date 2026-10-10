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
	// ready and waiting are indexed by whether runs are urgent. Urgent runs
	// are served first.
	ready   [2]*sync.Cond
	waiting [2]int
	idle    []*vm.Runtime
	// created counts runtimes that exist or are being created; creating
	// counts those being created in the background.
	created  int
	creating int
}

func newPool(modules *vm.Modules, logger *slog.Logger) *pool {
	p := &pool{modules: modules, logger: logger, limit: runtime.GOMAXPROCS(0)}
	p.ready = [2]*sync.Cond{sync.NewCond(&p.lock), sync.NewCond(&p.lock)}
	return p
}

// get lends a runtime. Urgent runs, whose results other runs wait on, take
// returned runtimes before other runs.
func (p *pool) get(urgent bool) (*vm.Runtime, error) {
	priority := 0
	if urgent {
		priority = 1
	}
	p.lock.Lock()
	// A run waits for a runtime being created rather than creating another.
	p.waiting[priority]++
	for len(p.idle) == 0 && (p.creating > 0 || p.created >= p.limit) {
		p.ready[priority].Wait()
	}
	p.waiting[priority]--
	if n := len(p.idle); n > 0 {
		runtime := p.idle[n-1]
		p.idle = p.idle[:n-1]
		// Several runtimes may have been returned while this run woke.
		if len(p.idle) > 0 {
			p.signal()
		}
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
		p.broadcast()
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
	p.signal()
}

// signal wakes one waiting run, urgent first. The caller holds the lock.
func (p *pool) signal() {
	if p.waiting[1] > 0 {
		p.ready[1].Signal()
	} else {
		p.ready[0].Signal()
	}
}

// broadcast wakes every waiting run. The caller holds the lock.
func (p *pool) broadcast() {
	p.ready[0].Broadcast()
	p.ready[1].Broadcast()
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
	p.broadcast()
}
