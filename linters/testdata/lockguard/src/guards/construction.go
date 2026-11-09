package guards

import "sync"

// Shared copies share one mutex, so it is a pointer. Writes while it is
// newly allocated are still construction.
type Shared struct {
	name    string
	mu      *sync.RWMutex
	entries map[string]int // want entries:`guardedBy \{"lock":"mu"\}`
}

func NewShared() *Shared {
	return &Shared{mu: &sync.RWMutex{}, entries: map[string]int{}}
}

func (s *Shared) Named(name string) *Shared {
	c := *s
	c.name = name
	return &c
}

func (s *Shared) Get(k string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.entries[k]
}

func (s *Shared) Peek(k string) int {
	return s.entries[k] // want `^"Shared.entries" read without locking "Shared.mu"$`
}

func (s *Shared) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries = nil
}

// Waiter is captured by a goroutine its constructor starts, which boxes the
// new value. Writes in the constructor are still construction.
type Waiter struct {
	cond *sync.Cond // want cond:`guardedBy \{"lock":""\}`
	lock sync.Mutex
	done bool // want done:`guardedBy \{"lock":"lock"\}`
}

func NewWaiter() *Waiter {
	w := &Waiter{}
	w.cond = sync.NewCond(&w.lock)
	go func() {
		w.lock.Lock()
		w.done = true
		w.lock.Unlock()
	}()
	return w
}

// NewWaiterFrom returns a value that NewWaiter allocates.
func NewWaiterFrom() *Waiter {
	w := NewWaiter()
	w.cond = nil
	return w
}

// NewReassigned stores to the captured variable twice, so it is not one value.
func NewReassigned(other *Waiter) *Waiter {
	w := &Waiter{}
	go func() { _ = w }()
	if other != nil {
		w = other
	}
	w.cond = nil // want `^"Waiter.cond" written after construction, but no mutex is declared before it$`
	return w
}

// NewRebound lets the closure replace the captured value.
func NewRebound(other *Waiter) *Waiter {
	w := &Waiter{}
	func() { w = other }()
	w.cond = nil // want `^"Waiter.cond" written after construction, but no mutex is declared before it$`
	return w
}

func (w *Waiter) Done() bool {
	return w.done // want `^"Waiter.done" read without locking "Waiter.lock"$`
}

// NewStarted shares the new value with a goroutine, which needs the lock.
func NewStarted() *Waiter {
	w := &Waiter{}
	go w.finish()
	return w
}

func (w *Waiter) finish() {
	w.done = true // want `^"Waiter.done" written without locking "Waiter.lock" in a new goroutine$`
}
