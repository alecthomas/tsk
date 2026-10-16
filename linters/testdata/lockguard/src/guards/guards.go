package guards

import (
	"sort"
	"sync"
	"sync/atomic"
)

type Cache struct {
	name  string
	size  atomic.Int64
	ready chan struct{}

	mu      sync.RWMutex
	entries map[string]string // want entries:`guardedBy \{"lock":"mu"\}`
	evicted atomic.Uint64
	order   []string // want order:`guardedBy \{"lock":"mu"\}`
	limit   int

	statsMu sync.Mutex
	wg      sync.WaitGroup
	// lookups counts calls to Get.
	lookups int // want lookups:`guardedBy \{"lock":"statsMu"\}`

	// A blank line does not end the group.
	misses int // want misses:`guardedBy \{"lock":"statsMu"\}`
}

func New(limit int) *Cache {
	c := &Cache{name: "cache", entries: map[string]string{}, ready: make(chan struct{})}
	c.limit = limit
	c.init()
	return c
}

// init only receives new caches, so its writes are part of construction.
func (c *Cache) init() {
	c.order = make([]string, 0, c.limit)
}

// NewNamed configures a cache from New, which returns it newly allocated.
func NewNamed(name string) *Cache {
	c := New(10)
	c.name = name
	return c
}

func (c *Cache) Name() string {
	return c.name
}

func (c *Cache) Limit() int {
	return c.limit
}

func (c *Cache) Size() int64 {
	c.evicted.Add(1)
	c.wg.Wait()
	<-c.ready
	return c.size.Load()
}

func (c *Cache) Miss() {
	c.misses++ // want `^"Cache.misses" written without locking "Cache.statsMu"$`
}

func (c *Cache) Get(key string) (string, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	c.countLookup()
	v, ok := c.entries[key]
	return v, ok
}

func (c *Cache) countLookup() {
	c.statsMu.Lock()
	c.lookups++
	c.statsMu.Unlock()
}

func (c *Cache) Put(key, value string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.putLocked(key, value)
}

func (c *Cache) putLocked(key, value string) {
	if _, ok := c.entries[key]; !ok { // want `^"Cache.entries" read without locking "Cache.mu"$`
		c.order = append(c.order, key)
	}
	c.entries[key] = value
}

func (c *Cache) Len() int {
	return len(c.order) // want `^"Cache.order" read without locking "Cache.mu"$`
}

func (c *Cache) Reset() {
	c.mu.RLock()
	defer c.mu.RUnlock()
	c.entries["reset"] = "" // want `^"Cache.entries" written without write-locking "Cache.mu"$`
}

func (c *Cache) Store(key, value string) {
	c.insert(key, value)
}

func (c *Cache) insert(key, value string) {
	c.putLocked(key, value)
}

func (c *Cache) lock() { c.mu.Lock() }

func (c *Cache) unlock() { c.mu.Unlock() }

func (c *Cache) Clear() {
	c.lock()
	defer c.unlock()
	c.entries = map[string]string{}
	c.order = nil
}

func (c *Cache) Maybe(lock bool) {
	if lock {
		c.mu.Lock()
		defer c.mu.Unlock()
	}
	c.order = nil // want `^"Cache.order" written without write-locking "Cache.mu"$`
}

func (c *Cache) Sorted() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	sort.Slice(c.order, func(i, j int) bool { return c.order[i] < c.order[j] })
	return c.order
}

func (c *Cache) Flush() {
	c.mu.Lock()
	defer c.mu.Unlock()
	go c.clearLocked()
	go func() {
		_ = c.entries["x"] // want `^"Cache.entries" read without locking "Cache.mu" in a new goroutine$`
	}()
}

func (c *Cache) Visit(visit func(func() int)) {
	visit(func() int {
		return c.count()
	})
}

func (c *Cache) count() int {
	return len(c.order) // want `^"Cache.order" read without locking "Cache.mu"$`
}

func (c *Cache) Finish() {
	c.finish()
}

func (c *Cache) Abort() {
	c.finish()
}

// finish's accesses miss the same lock from the same calls, so are reported once.
func (c *Cache) finish() {
	c.order = nil // want `^"Cache.order" written without write-locking "Cache.mu"$`
	c.entries = nil
	_ = c.count()
}

func (c *Cache) clearLocked() {
	c.order = nil // want `^"Cache.order" written without write-locking "Cache.mu" in a new goroutine$`
}

func (c *Cache) Callback() func() {
	return c.resetLocked
}

// resetLocked is only used as a value, so its requirement is reported here.
func (c *Cache) resetLocked() {
	c.order = nil // want `^"Cache.order" written without write-locking "Cache.mu"$`
}

func (c *Cache) unused() int {
	return c.lookups // want `^"Cache.lookups" read without locking "Cache.statsMu"$`
}

func (c *Cache) Debug() int {
	return len(c.order) //nolint:lockguard
}

type Loose struct {
	name string // want name:`guardedBy \{"lock":""\}`
	id   string

	mu    sync.Mutex
	n     int // want n:`guardedBy \{"lock":"mu"\}`
	other sync.Mutex
	a, b  int // want a:`guardedBy \{"lock":"other"\}` b:`guardedBy \{"lock":"other"\}`
}

func (l *Loose) Rename(name string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.name = name // want `^"Loose.name" written after construction, but no mutex is declared before it$`
	l.n++
}

func (l *Loose) ID() string {
	return l.id
}

func (l *Loose) Inc() {
	l.other.Lock()
	l.a++
	l.b++
	l.other.Unlock()
}

// Options is configured by other packages, which may write its exported fields.
type Options struct {
	Name string // want Name:`guardedBy \{"lock":""\}`

	mu   sync.Mutex
	Size int // want Size:`guardedBy \{"lock":"mu"\}`
}

func (o *Options) Label() string {
	return o.Name
}

func (o *Options) Get() int {
	return o.Size // want `^"Options.Size" read without locking "Options.mu"$`
}

// Plain has no mutex, so it is not checked.
type Plain struct {
	n int
}

func (p *Plain) Inc() {
	p.n++
}

var (
	defaultLimit = 10

	globalMu sync.Mutex
	hits     int // want hits:`guardedBy \{"lock":"globalMu"\}`
	version  string

	misses   int // want misses:`guardedBy \{"lock":"globalMu"\}`
	Exported int // want Exported:`guardedBy \{"lock":"globalMu"\}`
)

func init() {
	version = "1"
}

func Version() string {
	return version
}

func DefaultLimit() int {
	defaultLimit++
	return defaultLimit
}

func Hit() {
	globalMu.Lock()
	hits++
	globalMu.Unlock()
}

func Miss() {
	misses++ // want `^"misses" written without locking "globalMu"$`
}

func Lookup() {
	globalMu.Lock()
	defer globalMu.Unlock()
	recordMiss()
}

func recordMiss() {
	misses++
}

func ReadExported() int {
	globalMu.Lock()
	defer globalMu.Unlock()
	return Exported
}

type Counter struct {
	sync.Mutex
	n int // want n:`guardedBy \{"lock":"Mutex"\}`
}

func (c *Counter) Inc() {
	c.Lock()
	c.n++
	c.Unlock()
}

func (c *Counter) Peek() int {
	return c.n // want `^"Counter.n" read without locking "Counter.Mutex"$`
}

type Registry struct {
	counters map[string]*Counter
}

func (r *Registry) Inc(name string) {
	c := r.counters[name]
	c.Lock()
	c.n++
	c.Unlock()
}

func (r *Registry) Bad(name string) {
	r.counters[name].n++ // want `^"Counter.n" written without locking "Counter.Mutex"$`
}
