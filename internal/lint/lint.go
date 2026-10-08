// Package lint loads packages, runs analyzers over them, and prints findings.
package lint

import (
	"bytes"
	"fmt"
	"go/token"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/alecthomas/errors"
	"golang.org/x/tools/go/analysis"
	"golang.org/x/tools/go/analysis/checker"
	"golang.org/x/tools/go/packages"
)

// Config holds the options of a lint run.
type Config struct {
	Packages []string `arg:"" optional:"" default:"./..." help:"Package patterns to lint."`
	JSON     bool     `help:"Emit JSON output."`
	Context  int      `short:"c" default:"-1" help:"Lines of context to show around each finding; -1 shows none."`
	Test     bool     `default:"true" negatable:"" help:"Analyze test files too."`
}

// Run lints c.Packages in dir, printing text to stderr or JSON to stdout. Exit
// codes follow multichecker: 1 for errors, 3 for findings in text mode.
func Run(analyzers []*analysis.Analyzer, c Config, dir string, stdout, stderr io.Writer) (exitCode int, err error) {
	mode := packages.LoadSyntax | packages.NeedModule
	if needFacts(analyzers) {
		mode = packages.LoadAllSyntax | packages.NeedModule
	}
	initial, err := packages.Load(&packages.Config{Mode: mode, Dir: dir, Tests: c.Test}, c.Packages...)
	if err != nil {
		return 1, errors.Wrap(err, "load packages")
	}
	if len(initial) == 0 {
		return 1, errors.Errorf("%s matched no packages", strings.Join(c.Packages, " "))
	}
	// As in multichecker, package errors are reported but analysis continues.
	if printErrors(stderr, initial) > 0 {
		exitCode = 1
	}
	graph, err := checker.Analyze(analyzers, withoutTestMains(initial), nil)
	if err != nil {
		return 1, errors.Wrap(err, "analyze packages")
	}
	if c.JSON {
		return exitCode, errors.Wrap(graph.PrintJSON(stdout), "print JSON")
	}
	if err := printText(stderr, graph, c.Context, dir); err != nil {
		return 1, err
	}
	return max(exitCode, textExitCode(graph)), nil
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

func textExitCode(graph *checker.Graph) int {
	var failures, findings int
	for action := range graph.All() {
		if action.Err != nil {
			failures++
		} else if action.IsRoot {
			findings += len(action.Diagnostics)
		}
	}
	switch {
	case failures > 0:
		return 1
	case findings > 0:
		return 3
	default:
		return 0
	}
}

// printText writes each finding as "file:line:col: message (analyzer)", with
// paths relative to dir, then its related information and context lines.
func printText(w io.Writer, graph *checker.Graph, contextLines int, dir string) error {
	// A file in several packages, such as foo and foo.test, is analyzed once
	// per package, so findings are deduplicated by position, not token.Pos.
	type key struct {
		pos, end token.Position
		analyzer *analysis.Analyzer
		message  string
	}
	seen := map[key]bool{}
	var out bytes.Buffer
	for action := range graph.All() {
		if action.Err != nil {
			fmt.Fprintf(&out, "%s: %v\n", action.Analyzer.Name, action.Err)
			continue
		}
		if !action.IsRoot {
			continue
		}
		fset := action.Package.Fset
		printer := newTextPrinter(&out, fset, contextLines, dir)
		for _, diagnostic := range action.Diagnostics {
			k := key{fset.Position(diagnostic.Pos), fset.Position(diagnostic.End), action.Analyzer, diagnostic.Message}
			if seen[k] {
				continue
			}
			seen[k] = true
			printer.print(diagnostic.Pos, diagnostic.End, fmt.Sprintf("%s (%s)", diagnostic.Message, action.Analyzer.Name))
			for _, related := range diagnostic.Related {
				printer.print(related.Pos, related.End, "\t"+related.Message)
			}
		}
	}
	_, err := w.Write(out.Bytes())
	return errors.Wrap(err, "print findings")
}

type textPrinter struct {
	out          *bytes.Buffer
	fset         *token.FileSet
	contextLines int
	dir          string
}

func newTextPrinter(out *bytes.Buffer, fset *token.FileSet, contextLines int, dir string) textPrinter {
	return textPrinter{out: out, fset: fset, contextLines: contextLines, dir: dir}
}

func (p textPrinter) print(pos, end token.Pos, message string) {
	start := p.fset.Position(pos)
	filename := start.Filename
	if start.IsValid() {
		start.Filename = relative(p.dir, filename)
	}
	fmt.Fprintf(p.out, "%s: %s\n", start, message)
	if p.contextLines < 0 {
		return
	}
	last := p.fset.Position(end)
	if !last.IsValid() {
		last = start
	}
	data, _ := os.ReadFile(filename) //nolint:errcheck // Context is best effort.
	lines := strings.Split(string(data), "\n")
	for i := max(start.Line-p.contextLines, 1); i <= min(last.Line+p.contextLines, len(lines)); i++ {
		fmt.Fprintf(p.out, "%d\t%s\n", i, lines[i-1])
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
