package lint

import (
	"context"
	"log/slog"
	"time"

	"github.com/alecthomas/errors"
	"golang.org/x/tools/go/packages"

	"github.com/alecthomas/tsk/internal/inputs"
)

// Lookup finds a run's cached findings. Listing the packages and computing
// their content keys runs the go command and reads every file, but needs
// nothing from the scripts, so it starts at once and overlaps loading them.
type Lookup struct {
	cache  *Cache
	start  time.Time
	cancel context.CancelFunc
	// done is closed when listing finishes. Only then are keyer, linted,
	// and err set, and they do not change after.
	done   chan struct{}
	keyer  *keyer
	linted []*packages.Package
	err    error
}

// StartLookup starts listing c.Packages in dir, to look up their findings in
// cache. Close it when the run is done.
func StartLookup(ctx context.Context, cache *Cache, c Config, dir string) *Lookup {
	ctx, cancel := context.WithCancel(ctx)
	l := &Lookup{cache: cache, start: time.Now(), cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(l.done)
		l.keyer, l.linted, l.err = list(ctx, c, dir)
	}()
	return l
}

// Close stops listing, if it is still running, and waits for it to finish.
func (l *Lookup) Close() {
	l.cancel()
	<-l.done
}

// results waits for listing, then finds each package's entry cached with the
// scripts and settings a uses.
func (l *Lookup) results(ctx context.Context, logger *slog.Logger, a Analysis) (cachedRun, error) {
	<-l.done
	if l.err != nil {
		var none cachedRun
		return none, l.err
	}
	run := newCachedRun(ctx, logger, a, l.cache, l.keyer, l.linted)
	logger.InfoContext(ctx, "Looked up cached findings", "hits", len(run.findings()), "packages", len(l.linted), "duration", time.Since(l.start))
	return run, nil
}

// save caches the findings of the packages run analysed, then trims the
// cache.
func (l *Lookup) save(run cachedRun, recorder *inputs.Recorder, analysed []*packages.Package, findings map[string][]finding, failed map[string]bool) {
	for _, pkg := range analysed {
		run.store(l.cache, recorder, pkg, findings[pkg.ID], failed[pkg.ID])
	}
	l.cache.trim(time.Now())
}

// list lists c.Packages without syntax, which is cheap, and computes the
// content keys of those linted.
func list(ctx context.Context, c Config, dir string) (*keyer, []*packages.Package, error) {
	k, err := newKeyer(ctx, c.Test, dir)
	if err != nil {
		return nil, nil, err
	}
	mode := packages.NeedName | packages.NeedFiles | packages.NeedEmbedFiles | packages.NeedImports | packages.NeedDeps | packages.NeedModule
	initial, err := packages.Load(&packages.Config{Context: ctx, Mode: mode, Dir: dir, Tests: c.Test}, c.Packages...)
	if err != nil {
		return nil, nil, errors.Wrap(err, "list packages")
	}
	linted := lintedPackages(initial)
	for _, pkg := range linted {
		k.key(pkg)
	}
	return k, linted, nil
}
