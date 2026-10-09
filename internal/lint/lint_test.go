package lint_test

import (
	"bytes"
	"go/ast"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"

	"github.com/alecthomas/assert/v2"
	. "github.com/alecthomas/types/optional"
	"golang.org/x/tools/go/analysis"

	"github.com/alecthomas/tsk/internal/inputs"
	"github.com/alecthomas/tsk/internal/lint"
)

func funcsAnalyzer() *analysis.Analyzer {
	return &analysis.Analyzer{
		Name:       "funcs",
		Doc:        "Reports every function declaration.",
		ResultType: reflect.TypeFor[struct{}](),
		Run: func(pass *analysis.Pass) (any, error) {
			for _, file := range pass.Files {
				for _, decl := range file.Decls {
					if fn, ok := decl.(*ast.FuncDecl); ok {
						pass.Reportf(fn.Name.Pos(), "function %s", fn.Name.Name)
					}
				}
			}
			return struct{}{}, nil
		},
	}
}

// filesAnalyzer reports how many files each package pass sees.
func filesAnalyzer() *analysis.Analyzer {
	return &analysis.Analyzer{
		Name:       "files",
		Doc:        "Reports the number of files in each package.",
		ResultType: reflect.TypeFor[struct{}](),
		Run: func(pass *analysis.Pass) (any, error) {
			for _, file := range pass.Files {
				pass.Reportf(file.Name.Pos(), "files=%d", len(pass.Files))
			}
			return struct{}{}, nil
		},
	}
}

// notesAnalyzer reports each function with the contents of a note file, which
// it reads as scripts do, and counts the packages it analyses.
func notesAnalyzer(recorder *inputs.Recorder, note string, runs *atomic.Int32) *analysis.Analyzer {
	return &analysis.Analyzer{
		Name:       "notes",
		Doc:        "Reports every function with a note.",
		ResultType: reflect.TypeFor[struct{}](),
		Run: func(pass *analysis.Pass) (any, error) {
			runs.Add(1)
			data, err := recorder.For(pass.Pkg.Path()).ReadFile(note)
			if err != nil {
				return nil, err
			}
			for _, file := range pass.Files {
				for _, decl := range file.Decls {
					if fn, ok := decl.(*ast.FuncDecl); ok {
						pass.Reportf(fn.Name.Pos(), "%s %s", fn.Name.Name, data)
					}
				}
			}
			return struct{}{}, nil
		},
	}
}

func analyzers(list ...*analysis.Analyzer) lint.Analysis {
	return lint.Analysis{Analyzers: list, Recorder: inputs.NewRecorder()}
}

func TestRunCache(t *testing.T) {
	dir := t.TempDir()
	assert.NoError(t, os.CopyFS(dir, os.DirFS("testdata")))
	note := filepath.Join(t.TempDir(), "note.txt")
	assert.NoError(t, os.WriteFile(note, []byte("one"), 0o600))
	cache := lint.NewCache(t.TempDir())
	config := lint.Config{Packages: []string{"./..."}, Context: -1, Test: true}
	// run lints as a fresh tsk would, with nothing recorded yet, and returns
	// its output and how many packages it analysed.
	run := func(t *testing.T) (string, int32) {
		t.Helper()
		var runs atomic.Int32
		recorder := inputs.NewRecorder()
		analysis := lint.Analysis{Analyzers: []*analysis.Analyzer{notesAnalyzer(recorder, note, &runs)}, Recorder: recorder, Fingerprint: "test"}
		var stdout, stderr bytes.Buffer
		code, err := lint.Run(t.Context(), slog.New(slog.DiscardHandler), analysis, Some(cache), config, dir, &stdout, &stderr)
		assert.NoError(t, err)
		assert.Equal(t, 3, code)
		return stderr.String(), runs.Load()
	}

	want := "sub/sub.go:3:6: A one (notes)\nsub/sub.go:5:6: B one (notes)\nsub/sub_test.go:5:6: TestC one (notes)\n"
	output, runs := run(t)
	assert.Equal(t, want, output)
	assert.Equal(t, 1, runs)

	output, runs = run(t)
	assert.Equal(t, want, output, "cached")
	assert.Equal(t, 0, runs)

	assert.NoError(t, os.WriteFile(filepath.Join(dir, "sub", "sub.go"), []byte("package sub\n\nfunc A() {}\n"), 0o600))
	output, runs = run(t)
	assert.Equal(t, "sub/sub.go:3:6: A one (notes)\nsub/sub_test.go:5:6: TestC one (notes)\n", output, "source changed")
	assert.Equal(t, 1, runs)

	assert.NoError(t, os.WriteFile(note, []byte("two"), 0o600))
	output, runs = run(t)
	assert.Equal(t, "sub/sub.go:3:6: A two (notes)\nsub/sub_test.go:5:6: TestC two (notes)\n", output, "read changed")
	assert.Equal(t, 1, runs)
}

func TestRunLintsOnlyTestVariant(t *testing.T) {
	dir, err := filepath.Abs("testdata")
	assert.NoError(t, err)
	var stdout, stderr bytes.Buffer
	config := lint.Config{Packages: []string{"./..."}, Context: -1, Test: true}
	_, err = lint.Run(t.Context(), slog.New(slog.DiscardHandler), analyzers(filesAnalyzer()), None[*lint.Cache](), config, dir, &stdout, &stderr)
	assert.NoError(t, err)
	assert.Equal(t, "sub/sub.go:1:9: files=2 (files)\nsub/sub_test.go:1:9: files=2 (files)\n", stderr.String())
}

func TestRunText(t *testing.T) {
	dir, err := filepath.Abs("testdata")
	assert.NoError(t, err)
	tests := []struct {
		Name    string
		Context int
		Want    string
	}{
		// The generated test main's functions are not reported.
		{Name: "NoContext", Context: -1, Want: "sub/sub.go:3:6: function A (funcs)\n" +
			"sub/sub.go:5:6: function B (funcs)\n" +
			"sub/sub_test.go:5:6: function TestC (funcs)\n"},
		{Name: "Context", Context: 0, Want: "sub/sub.go:3:6: function A (funcs)\n3\tfunc A() {}\n" +
			"sub/sub.go:5:6: function B (funcs)\n5\tfunc B() {}\n" +
			"sub/sub_test.go:5:6: function TestC (funcs)\n5\tfunc TestC(t *testing.T) {}\n"},
	}
	for _, test := range tests {
		t.Run(test.Name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			config := lint.Config{Packages: []string{"./..."}, Context: test.Context, Test: true}
			code, err := lint.Run(t.Context(), slog.New(slog.DiscardHandler), analyzers(funcsAnalyzer()), None[*lint.Cache](), config, dir, &stdout, &stderr)
			assert.NoError(t, err)
			assert.Equal(t, 3, code)
			assert.Equal(t, test.Want, stderr.String())
			assert.Equal(t, "", stdout.String())
		})
	}
}
