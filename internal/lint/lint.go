// Package lint loads packages, runs analyzers over them, and prints findings.
package lint

import (
	"bytes"
	"cmp"
	"context"
	"fmt"
	"go/token"
	"io"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/alecthomas/errors"
	. "github.com/alecthomas/types/optional"
	"golang.org/x/tools/go/analysis"
	"golang.org/x/tools/go/analysis/checker"
	"golang.org/x/tools/go/packages"

	"github.com/alecthomas/tsk/internal/inputs"
)

// Config holds the options of a lint run.
type Config struct {
	Packages []string `arg:"" optional:"" default:"./..." help:"Package patterns to lint."`
	JSON     bool     `help:"Emit JSON output."`
	Context  int      `short:"c" default:"-1" help:"Lines of context to show around each finding; -1 shows none."`
	Test     bool     `default:"true" negatable:"" help:"Analyze test files too."`
}

// Analysis is what a run checks packages with.
type Analysis struct {
	Analyzers []*analysis.Analyzer
	// Recorder holds what the analyzers read from the file system.
	Recorder *inputs.Recorder
	// Fingerprint identifies the scripts and settings behind the analyzers.
	Fingerprint string
}

// finding is a diagnostic resolved to file positions, as cached and printed.
type finding struct {
	Analyzer string         `json:"analyzer"`
	Pos      token.Position `json:"pos"`
	End      token.Position `json:"end"`
	Message  string         `json:"message"`
	Related  []related      `json:"related,omitzero"`
}

type related struct {
	Pos     token.Position `json:"pos"`
	End     token.Position `json:"end"`
	Message string         `json:"message"`
}

// Run lints c.Packages in dir, printing text to stderr or JSON to stdout. Exit
// codes follow multichecker: 1 for errors, 3 for findings in text mode. With
// a lookup of cached findings, text mode reuses the findings of packages
// whose inputs are unchanged and analyses only the rest.
func Run(ctx context.Context, logger *slog.Logger, a Analysis, lookup Option[*Lookup], c Config, dir string, stdout, stderr io.Writer) (exitCode int, err error) {
	if c.JSON {
		return runJSON(ctx, a, c, dir, stdout, stderr)
	}
	findings := map[string][]finding{}
	var cached cachedRun
	if l, ok := lookup.Get(); ok {
		cached, err = l.results(ctx, logger, a)
		if err != nil {
			return 1, err
		}
		maps.Copy(findings, cached.findings())
		if cached.complete() {
			return printFindings(stderr, findings, 0, false, c.Context, dir)
		}
	}
	initial, err := load(ctx, a.Analyzers, c, dir)
	if err != nil {
		return 1, err
	}
	if printErrors(stderr, initial) > 0 {
		exitCode = 1
	}
	roots := slices.DeleteFunc(lintedPackages(initial), func(pkg *packages.Package) bool {
		return cached.hit(pkg.ID)
	})
	graph, err := checker.Analyze(a.Analyzers, roots, nil)
	if err != nil {
		return 1, errors.Wrap(err, "analyze packages")
	}
	failed := map[string]bool{}
	var failures bytes.Buffer
	for action := range graph.All() {
		switch {
		case action.Err != nil:
			fmt.Fprintf(&failures, "%s: %v\n", action.Analyzer.Name, action.Err)
			failed[action.Package.ID] = true
		case action.IsRoot:
			findings[action.Package.ID] = append(findings[action.Package.ID], resolve(action)...)
		}
	}
	if _, err := stderr.Write(failures.Bytes()); err != nil {
		return 1, errors.Wrap(err, "print failures")
	}
	if l, ok := lookup.Get(); ok {
		l.save(cached, a.Recorder, roots, findings, failed)
	}
	return printFindings(stderr, findings, exitCode, len(failed) > 0, c.Context, dir)
}

// runJSON lints without the cache, printing the checker's JSON tree.
func runJSON(ctx context.Context, a Analysis, c Config, dir string, stdout, stderr io.Writer) (exitCode int, err error) {
	initial, err := load(ctx, a.Analyzers, c, dir)
	if err != nil {
		return 1, err
	}
	if printErrors(stderr, initial) > 0 {
		exitCode = 1
	}
	graph, err := checker.Analyze(a.Analyzers, lintedPackages(initial), nil)
	if err != nil {
		return 1, errors.Wrap(err, "analyze packages")
	}
	return exitCode, errors.Wrap(graph.PrintJSON(stdout), "print JSON")
}

// load loads c.Packages with syntax for analysis.
func load(ctx context.Context, analyzers []*analysis.Analyzer, c Config, dir string) ([]*packages.Package, error) {
	mode := packages.LoadSyntax | packages.NeedModule
	if needFacts(analyzers) {
		mode = packages.LoadAllSyntax | packages.NeedModule
	}
	initial, err := packages.Load(&packages.Config{Context: ctx, Mode: mode, Dir: dir, Tests: c.Test}, c.Packages...)
	if err != nil {
		return nil, errors.Wrap(err, "load packages")
	}
	if len(initial) == 0 {
		return nil, errors.Errorf("%s matched no packages", strings.Join(c.Packages, " "))
	}
	return initial, nil
}

// cachedRun is what the cache held for a run's packages.
type cachedRun struct {
	// keys maps the IDs of cacheable packages to their cache keys.
	keys map[string]string
	// hits maps package IDs to their still-valid entries.
	hits map[string]entry
	// allHit is set when every package hit.
	allHit bool
}

// newCachedRun finds the entries cache holds for linted packages, with the
// content keys keyer computed and the scripts and settings a uses.
func newCachedRun(ctx context.Context, logger *slog.Logger, a Analysis, cache *Cache, keyer *keyer, linted []*packages.Package) cachedRun {
	run := cachedRun{keys: map[string]string{}, hits: map[string]entry{}}
	for _, pkg := range linted {
		contentKey, cacheable := keyer.key(pkg)
		if !cacheable {
			logger.DebugContext(ctx, "Cache miss", "package", pkg.ID, "reason", "not cacheable")
			continue
		}
		key := cacheKey(a.Fingerprint, contentKey)
		run.keys[pkg.ID] = key
		e, stored := cache.load(key)
		switch {
		case !stored:
			logger.DebugContext(ctx, "Cache miss", "package", pkg.ID, "reason", "not stored")
		case !a.Recorder.Valid(e.Observations):
			logger.DebugContext(ctx, "Cache miss", "package", pkg.ID, "reason", "files read changed")
		default:
			run.hits[pkg.ID] = e
		}
	}
	run.allHit = len(linted) > 0 && len(run.hits) == len(linted)
	return run
}

// findings returns the cached findings by package ID.
func (r cachedRun) findings() map[string][]finding {
	findings := map[string][]finding{}
	for id, e := range r.hits {
		findings[id] = e.Findings
	}
	return findings
}

func (r cachedRun) hit(id string) bool {
	_, ok := r.hits[id]
	return ok
}

// complete reports whether every package hit, so none need loading.
func (r cachedRun) complete() bool {
	return r.allHit
}

// store caches a package's findings, unless analysing it failed or it or a
// dependency has errors, which only a fresh load reports. The entry holds
// what analysing it and its dependencies read, which feeds its findings
// directly or through facts.
func (r cachedRun) store(cache *Cache, recorder *inputs.Recorder, pkg *packages.Package, findings []finding, failed bool) {
	key, ok := r.keys[pkg.ID]
	if !ok || failed {
		return
	}
	var paths []string
	for dep := range packages.Postorder([]*packages.Package{pkg}) {
		if len(dep.Errors) > 0 || len(dep.TypeErrors) > 0 {
			return
		}
		paths = append(paths, dep.PkgPath)
	}
	_ = cache.store(key, entry{Observations: recorder.Observations(paths), Findings: findings}) //nolint:errcheck // Caching is best effort.
}

// lintedPackages drops the packages loading with tests adds but which are not
// linted.
func lintedPackages(pkgs []*packages.Package) []*packages.Package {
	return withoutTestedVariants(withoutTestMains(pkgs))
}

// withoutTestMains drops the test binaries that loading with Tests adds. In
// go/packages' IDs, loading "fmt" with tests also yields its test binary,
// "fmt.test", whose source go test generates rather than the user writes.
func withoutTestMains(pkgs []*packages.Package) []*packages.Package {
	loaded := map[string]bool{}
	for _, pkg := range pkgs {
		loaded[pkg.ID] = true
	}
	return slices.DeleteFunc(slices.Clone(pkgs), func(pkg *packages.Package) bool {
		tested, isBinary := strings.CutSuffix(pkg.ID, ".test")
		return isBinary && loaded[tested]
	})
}

// withoutTestedVariants drops a package when the variant compiled for its own
// tests, "fmt [fmt.test]" beside "fmt" in go/packages' IDs, is loaded too. That
// variant holds the same files plus the in-package tests, so code only the
// tests use is not reported unused.
func withoutTestedVariants(pkgs []*packages.Package) []*packages.Package {
	loaded := map[string]bool{}
	for _, pkg := range pkgs {
		loaded[pkg.ID] = true
	}
	return slices.DeleteFunc(slices.Clone(pkgs), func(pkg *packages.Package) bool {
		return loaded[pkg.ID+" ["+pkg.ID+".test]"]
	})
}

// needFacts reports whether an analyzer, or one it requires, uses facts, so
// dependencies must be loaded from source.
func needFacts(analyzers []*analysis.Analyzer) bool {
	seen := map[*analysis.Analyzer]bool{}
	queue := append([]*analysis.Analyzer(nil), analyzers...)
	for len(queue) > 0 {
		analyzer := queue[0]
		queue = queue[1:]
		if seen[analyzer] {
			continue
		}
		seen[analyzer] = true
		if len(analyzer.FactTypes) > 0 {
			return true
		}
		queue = append(queue, analyzer.Requires...)
	}
	return false
}

// printErrors mirrors packages.PrintErrors, which only writes to os.Stderr.
func printErrors(w io.Writer, pkgs []*packages.Package) (count int) {
	modules := map[*packages.Module]bool{}
	for pkg := range packages.Postorder(pkgs) {
		for _, err := range pkg.Errors {
			fmt.Fprintln(w, err) //nolint:errcheck // Output is best effort.
			count++
		}
		if module := pkg.Module; module != nil && module.Error != nil && !modules[module] {
			modules[module] = true
			fmt.Fprintln(w, module.Error.Err) //nolint:errcheck // Output is best effort.
			count++
		}
	}
	return count
}

// resolve converts an action's diagnostics to file positions.
func resolve(action *checker.Action) []finding {
	fset := action.Package.Fset
	findings := make([]finding, 0, len(action.Diagnostics))
	for _, diagnostic := range action.Diagnostics {
		f := finding{
			Analyzer: action.Analyzer.Name,
			Pos:      fset.Position(diagnostic.Pos),
			End:      fset.Position(diagnostic.End),
			Message:  diagnostic.Message,
		}
		for _, info := range diagnostic.Related {
			f.Related = append(f.Related, related{Pos: fset.Position(info.Pos), End: fset.Position(info.End), Message: info.Message})
		}
		findings = append(findings, f)
	}
	return findings
}

// printFindings writes each finding as "file:line:col: message (analyzer)",
// in position order with paths relative to dir, then its related information
// and context lines. It returns the exit code: 1 if an analyzer failed,
// otherwise 3 if there were findings, and never less than loadCode.
func printFindings(w io.Writer, byPackage map[string][]finding, loadCode int, failed bool, contextLines int, dir string) (int, error) {
	var all []finding
	for _, findings := range byPackage {
		all = append(all, findings...)
	}
	slices.SortFunc(all, func(a, b finding) int {
		return cmp.Or(
			cmp.Compare(a.Pos.Filename, b.Pos.Filename),
			cmp.Compare(a.Pos.Offset, b.Pos.Offset),
			cmp.Compare(a.Analyzer, b.Analyzer),
			cmp.Compare(a.Message, b.Message),
		)
	})
	// A file in several packages, such as foo and foo_test's test variant, is
	// analysed once per package, so equal findings print once.
	all = slices.CompactFunc(all, func(a, b finding) bool {
		return a.Pos == b.Pos && a.End == b.End && a.Analyzer == b.Analyzer && a.Message == b.Message
	})
	var out bytes.Buffer
	for _, f := range all {
		printPosition(&out, f.Pos, f.End, fmt.Sprintf("%s (%s)", f.Message, f.Analyzer), contextLines, dir)
		for _, info := range f.Related {
			printPosition(&out, info.Pos, info.End, "\t"+info.Message, contextLines, dir)
		}
	}
	if _, err := w.Write(out.Bytes()); err != nil {
		return 1, errors.Wrap(err, "print findings")
	}
	switch {
	case failed:
		return max(loadCode, 1), nil
	case len(all) > 0:
		return max(loadCode, 3), nil
	default:
		return loadCode, nil
	}
}

func printPosition(out *bytes.Buffer, start, end token.Position, message string, contextLines int, dir string) {
	filename := start.Filename
	if start.IsValid() {
		start.Filename = relative(dir, filename)
	}
	fmt.Fprintf(out, "%s: %s\n", start, message)
	if contextLines < 0 {
		return
	}
	if !end.IsValid() {
		end = start
	}
	data, _ := os.ReadFile(filename) //nolint:errcheck // Context is best effort.
	lines := strings.Split(string(data), "\n")
	for i := max(start.Line-contextLines, 1); i <= min(end.Line+contextLines, len(lines)); i++ {
		fmt.Fprintf(out, "%d\t%s\n", i, lines[i-1])
	}
}

// relative returns filename relative to dir, or unchanged if it has no
// relative form.
func relative(dir, filename string) string {
	if rel, err := filepath.Rel(dir, filename); err == nil {
		return rel
	}
	return filename
}
