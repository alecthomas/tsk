// Package nolint applies //nolint comments, the suppression convention of
// gometalinter and golangci-lint, to analyzer findings.
package nolint

import (
	"go/ast"
	"go/token"
	"slices"
	"strings"
	"sync"
	"unicode"

	"golang.org/x/tools/go/analysis"
)

// Reporter wraps pass.Report to drop the analyzer's findings that a //nolint
// comment suppresses. Comments are only scanned once a finding is reported.
func Reporter(pass *analysis.Pass, analyzer string) func(analysis.Diagnostic) {
	index := sync.OnceValue(func() map[*token.File][]directive { return scan(pass.Fset, pass.Files) })
	return func(diagnostic analysis.Diagnostic) {
		file := pass.Fset.File(diagnostic.Pos)
		if file != nil {
			line := file.Line(diagnostic.Pos)
			if slices.ContainsFunc(index()[file], func(d directive) bool { return d.suppresses(analyzer, line) }) {
				return
			}
		}
		pass.Report(diagnostic)
	}
}

// directive is a //nolint comment and the lines it covers.
type directive struct {
	from, to int
	column   int
	// analyzers lists the analyzers suppressed; empty suppresses all.
	analyzers []string
}

func newDirective(position token.Position, analyzers []string) directive {
	return directive{from: position.Line, to: position.Line, column: position.Column, analyzers: analyzers}
}

func (d *directive) line() int { return d.from }

// precedes reports whether the directive is on the line above a position, in
// its column.
func (d *directive) precedes(position token.Position) bool {
	return d.from == position.Line-1 && d.column == position.Column
}

func (d *directive) coverTo(line int) { d.to = max(d.to, line) }

func (d *directive) suppresses(analyzer string, line int) bool {
	return line >= d.from && line <= d.to && (len(d.analyzers) == 0 || slices.Contains(d.analyzers, analyzer))
}

func scan(fset *token.FileSet, files []*ast.File) map[*token.File][]directive {
	index := map[*token.File][]directive{}
	for _, file := range files {
		if directives := fileDirectives(fset, file); len(directives) > 0 {
			index[fset.File(file.Pos())] = directives
		}
	}
	return index
}

func fileDirectives(fset *token.FileSet, file *ast.File) []directive {
	var directives []directive
	for _, group := range file.Comments {
		for _, comment := range group.List {
			analyzers, ok := parse(comment.Text)
			if !ok {
				continue
			}
			directives = append(directives, newDirective(fset.Position(comment.Slash), analyzers))
		}
	}
	if len(directives) > 0 {
		extend(fset, file, directives)
	}
	return directives
}

// extend widens a directive on the line above a node, in the node's column,
// to the whole node, as golangci-lint does, so a comment above a function
// covers its body.
func extend(fset *token.FileSet, file *ast.File, directives []directive) {
	byLine := map[int][]int{}
	for i, d := range directives {
		byLine[d.line()] = append(byLine[d.line()], i)
	}
	for node := range ast.Preorder(file) {
		start := fset.Position(node.Pos())
		for _, i := range byLine[start.Line-1] {
			if directives[i].precedes(start) {
				directives[i].coverTo(fset.Position(node.End()).Line)
			}
		}
	}
}

// parse reads the analyzers a //nolint comment names, separated by commas.
// Naming none suppresses every analyzer. A reason may follow after a space.
func parse(text string) (analyzers []string, ok bool) {
	rest, ok := strings.CutPrefix(text, "//nolint")
	if !ok {
		return nil, false
	}
	if end := strings.IndexFunc(rest, unicode.IsSpace); end >= 0 {
		rest = rest[:end]
	}
	if rest == "" {
		return nil, true
	}
	names, ok := strings.CutPrefix(rest, ":")
	if !ok || names == "" {
		return nil, false
	}
	return strings.Split(names, ","), true
}
