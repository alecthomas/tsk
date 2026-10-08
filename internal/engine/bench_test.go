package engine_test

import (
	"context"
	"encoding/json"
	"go/ast"
	"log/slog"
	"reflect"
	"testing"

	"github.com/alecthomas/assert/v2"
	"golang.org/x/tools/go/analysis"
	"golang.org/x/tools/go/analysis/checker"
	"golang.org/x/tools/go/analysis/passes/inspect"
	"golang.org/x/tools/go/ast/inspector"
	"golang.org/x/tools/go/packages"

	"github.com/alecthomas/tsk/internal/compile"
	"github.com/alecthomas/tsk/internal/config"
	"github.com/alecthomas/tsk/internal/engine"
	"github.com/alecthomas/tsk/linters"
)

// module is this repository's module, the main module the benchmarks lint.
const module = "github.com/alecthomas/tsk"

const noopScript = `import { defineAnalyzer } from "tsk";

export default defineAnalyzer({ name: "bench", doc: "do nothing", run() {} });
`

// identScript counts identifiers; traversal is the loop that varies.
func identScript(traversal string) string {
	return `import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";
import * as ast from "go/ast";

export default defineAnalyzer({
  name: "bench",
  doc: "count identifiers",
  requires: [inspect],
  run(pass) {
    const root = pass.resultOf(inspect).root();
    let count = 0;
    ` + traversal + `
    return count;
  },
});
`
}

// BenchmarkAnalysis compares the scripting engine with equivalent Go
// analyzers over this repository's packages. Packages load once, outside the
// timings, so only analysis is measured. Each pair must produce the same
// count, so a broken script cannot look fast.
func BenchmarkAnalysis(b *testing.B) {
	pkgs := loadRepository(b)
	idents := countIdents(pkgs)
	cases := []struct {
		name     string
		goRun    func(*analysis.Pass) (any, error)
		script   string
		perIdent bool
	}{
		{
			name:   "Noop",
			goRun:  func(*analysis.Pass) (any, error) { return 0, nil },
			script: noopScript,
		},
		{
			name:     "Preorder",
			goRun:    goIdents(func(*analysis.Pass, *ast.Ident) bool { return true }),
			script:   identScript(`for (const _ of root.preorder(ast.Ident)) count++;`),
			perIdent: true,
		},
		{
			name:     "NativeFilter",
			goRun:    goIdents(func(pass *analysis.Pass, ident *ast.Ident) bool { return pass.TypesInfo.Types[ident].IsNil() }),
			script:   identScript(`for (const _ of root.preorder(ast.Ident).filter(pass.typesInfo.isNil)) count++;`),
			perIdent: true,
		},
		{
			name:     "ScriptFilter",
			goRun:    goIdents(func(_ *analysis.Pass, ident *ast.Ident) bool { return ident.Name != "_" }),
			script:   identScript(`for (const _ of root.preorder(ast.Ident).filter((c) => (c.node() as ast.Ident).name !== "_")) count++;`),
			perIdent: true,
		},
		{
			name:  "InspectCallback",
			goRun: goInspect,
			script: identScript(`for (const file of pass.files) {
      ast.inspect(file, (node) => {
        if (node?.$type === "Ident") {
          count++;
        }
        return true;
      });
    }`),
			perIdent: true,
		},
	}
	for _, c := range cases {
		goAnalyzer := &analysis.Analyzer{
			Name:       "bench",
			Doc:        "benchmark",
			Run:        c.goRun,
			ResultType: reflect.TypeFor[int](),
		}
		// Only traversals need inspect; the no-op scripts do not require it.
		if c.perIdent {
			goAnalyzer.Requires = []*analysis.Analyzer{inspect.Analyzer}
		}
		scriptAnalyzer := scriptAnalyzers(b, c.script)[0]
		assert.Equal(b, analyze(b, pkgs, goAnalyzer), analyze(b, pkgs, scriptAnalyzer), "%s: Go and script results differ", c.name)
		for _, variant := range []struct {
			name     string
			analyzer *analysis.Analyzer
		}{{"Go", goAnalyzer}, {"Script", scriptAnalyzer}} {
			b.Run(c.name+"/"+variant.name, func(b *testing.B) {
				for b.Loop() {
					analyze(b, pkgs, variant.analyzer)
				}
				if c.perIdent {
					b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*idents), "ns/ident")
				}
			})
		}
	}
	b.Run("Linters", func(b *testing.B) {
		e, err := engine.Load(context.Background(), slog.New(slog.DiscardHandler), []compile.Source{{Name: "builtin", FS: linters.Scripts}})
		assert.NoError(b, err)
		analyzers, err := e.Analyzers(config.File{}, []string{module})
		assert.NoError(b, err)
		for b.Loop() {
			_, err := checker.Analyze(analyzers, pkgs, nil)
			assert.NoError(b, err)
		}
	})
}

// loadRepository loads this repository's packages as multichecker does: from
// source, with module information, which module scope needs.
func loadRepository(b *testing.B) []*packages.Package {
	b.Helper()
	pkgs, err := packages.Load(&packages.Config{Mode: packages.LoadAllSyntax | packages.NeedModule, Dir: "../.."}, "./...")
	assert.NoError(b, err)
	assert.Equal(b, 0, packages.PrintErrors(pkgs))
	return pkgs
}

func countIdents(pkgs []*packages.Package) int {
	count := 0
	for _, pkg := range pkgs {
		for _, file := range pkg.Syntax {
			ast.Inspect(file, func(node ast.Node) bool {
				if _, ok := node.(*ast.Ident); ok {
					count++
				}
				return true
			})
		}
	}
	return count
}

// goIdents counts the identifiers keep accepts, traversing as the scripts do.
func goIdents(keep func(*analysis.Pass, *ast.Ident) bool) func(*analysis.Pass) (any, error) {
	return func(pass *analysis.Pass) (any, error) {
		root := pass.ResultOf[inspect.Analyzer].(*inspector.Inspector).Root() //nolint:forcetypeassert // inspect's result type.
		count := 0
		for cursor := range root.Preorder((*ast.Ident)(nil)) {
			if keep(pass, cursor.Node().(*ast.Ident)) { //nolint:forcetypeassert // Preorder filtered to identifiers.
				count++
			}
		}
		return count, nil
	}
}

func goInspect(pass *analysis.Pass) (any, error) {
	count := 0
	for _, file := range pass.Files {
		ast.Inspect(file, func(node ast.Node) bool {
			if _, ok := node.(*ast.Ident); ok {
				count++
			}
			return true
		})
	}
	return count, nil
}

func scriptAnalyzers(b *testing.B, script string) []*analysis.Analyzer {
	b.Helper()
	analyzers, err := load(b, map[string]string{"bench.ts": script}).Analyzers(config.File{}, []string{module})
	assert.NoError(b, err)
	return analyzers
}

// analyze runs one analyzer over pkgs and sums its per-package counts.
func analyze(b *testing.B, pkgs []*packages.Package, analyzer *analysis.Analyzer) int {
	b.Helper()
	graph, err := checker.Analyze([]*analysis.Analyzer{analyzer}, pkgs, nil)
	assert.NoError(b, err)
	total := 0
	for _, action := range graph.Roots {
		assert.NoError(b, action.Err)
		switch result := action.Result.(type) {
		case int:
			total += result
		case json.RawMessage:
			var count int
			if string(result) != "null" {
				assert.NoError(b, json.Unmarshal(result, &count))
			}
			total += count
		}
	}
	return total
}
