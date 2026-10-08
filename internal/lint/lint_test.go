package lint_test

import (
	"bytes"
	"go/ast"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/alecthomas/assert/v2"
	"golang.org/x/tools/go/analysis"

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
			code, err := lint.Run([]*analysis.Analyzer{funcsAnalyzer()}, config, dir, &stdout, &stderr)
			assert.NoError(t, err)
			assert.Equal(t, 3, code)
			assert.Equal(t, test.Want, stderr.String())
			assert.Equal(t, "", stdout.String())
		})
	}
}
