package engine

import (
	"go/ast"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/tools/go/analysis"

	"github.com/alecthomas/tsk/internal/config"
)

// filter drops the diagnostics an analyzer's config excludes: in test files,
// in generated files, or matching an exclusion.
type filter struct {
	analyzer string
	// group is the analyzer's group, or empty.
	group         string
	skipTests     bool
	skipGenerated bool
	excluder      config.Excluder
	// root is the directory exclusion paths are relative to.
	root string
}

func newFilter(analyzer, group string, skipTests, skipGenerated bool, excluder config.Excluder, root string) filter {
	return filter{analyzer: analyzer, group: group, skipTests: skipTests, skipGenerated: skipGenerated, excluder: excluder, root: root}
}

// reporter returns a Report for pass that passes on to report only the
// diagnostics the filter keeps.
func (f filter) reporter(pass *analysis.Pass, report func(analysis.Diagnostic)) func(analysis.Diagnostic) {
	cache := newGeneratedFiles()
	return func(diagnostic analysis.Diagnostic) {
		if !f.dropped(pass, cache, diagnostic) {
			report(diagnostic)
		}
	}
}

func (f filter) dropped(pass *analysis.Pass, cache *generatedFiles, diagnostic analysis.Diagnostic) bool {
	position := pass.Fset.Position(diagnostic.Pos)
	if f.skipTests && strings.HasSuffix(position.Filename, "_test.go") {
		return true
	}
	if f.skipGenerated && cache.contains(pass, diagnostic.Pos) {
		return true
	}
	return !f.excluder.Empty() && f.excluder.Excluded(config.Finding{
		Analyzer: f.analyzer,
		Group:    f.group,
		Path:     f.relative(position.Filename),
		Message:  diagnostic.Message,
		Source:   func() string { return sourceLine(position) },
	})
}

// relative returns path relative to the root, with "/" separators.
func (f filter) relative(path string) string {
	if f.root != "" {
		if relative, err := filepath.Rel(f.root, path); err == nil {
			path = relative
		}
	}
	return filepath.ToSlash(path)
}

// generatedFiles caches whether each file of a pass is generated. The pass's
// Report may be called from several goroutines, so the cache is locked.
type generatedFiles struct {
	mu    sync.Mutex
	files map[*ast.File]bool
}

func newGeneratedFiles() *generatedFiles {
	return &generatedFiles{files: map[*ast.File]bool{}}
}

// contains reports whether pos lies in a generated file of the package.
func (g *generatedFiles) contains(pass *analysis.Pass, pos token.Pos) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, file := range pass.Files {
		if file.FileStart <= pos && pos <= file.FileEnd {
			generated, ok := g.files[file]
			if !ok {
				// Go's convention, as golangci-lint's default "strict" mode uses.
				generated = ast.IsGenerated(file)
				g.files[file] = generated
			}
			return generated
		}
	}
	return false
}

// sourceLine returns the line at position, or "" if the file cannot be read.
func sourceLine(position token.Position) string {
	data, err := os.ReadFile(position.Filename)
	if err != nil {
		return ""
	}
	lines := strings.Split(string(data), "\n")
	if position.Line < 1 || position.Line > len(lines) {
		return ""
	}
	return strings.TrimSuffix(lines[position.Line-1], "\r")
}
