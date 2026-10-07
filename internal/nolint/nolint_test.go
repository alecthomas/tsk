package nolint_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"

	"github.com/alecthomas/assert/v2"
	"golang.org/x/tools/go/analysis"

	"github.com/alecthomas/tsktsk/internal/nolint"
)

const source = `package p

func a() int {
	return 1 //nolint:foo
}

//nolint:foo // Covers the whole function.
func b() int {
	x := 1
	return x
}

func c() int {
	//nolint:bar
	x := 1
	return x
}

func d() int {
	return 1 //nolint
}

func e() int {
	return 1 //nolint:bar,foo The reason.
}

func f() int {
//nolint:foo
	x := 1
	return x
}

var g = 1 //nolintfoo
`

// Reports a finding for analyzer foo at the start of every line, and returns
// the lines whose findings were kept.
func TestReporter(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "p.go", source, parser.ParseComments)
	assert.NoError(t, err)
	var kept []int
	pass := &analysis.Pass{
		Fset:  fset,
		Files: []*ast.File{file},
		Report: func(diagnostic analysis.Diagnostic) {
			kept = append(kept, fset.Position(diagnostic.Pos).Line)
		},
	}
	report := nolint.Reporter(pass, "foo")
	tokenFile := fset.File(file.Pos())
	for line := 1; line <= tokenFile.LineCount(); line++ {
		report(analysis.Diagnostic{Pos: tokenFile.LineStart(line)})
	}
	assert.Equal(t, []int{
		1, 2, 3, 5, 6, // a: only the commented line.
		12, 13, 14, 15, 16, 17, 18, // c: bar is not foo.
		19, 21, 22, // d: every analyzer.
		23, 25, 26, // e: foo is listed.
		27, 29, 30, 31, 32, // f: the comment is not in the statement's column.
		33, // g: not a directive.
	}, kept)
}
