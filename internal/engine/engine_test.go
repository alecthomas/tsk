package engine_test

import (
	"bytes"
	"context"
	"log/slog"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/alecthomas/assert/v2"
	ts "github.com/microsoft/TypeScript/tsc/shim/typescript"
	"golang.org/x/tools/go/analysis/analysistest"

	"github.com/alecthomas/tsk/internal/compile"
	"github.com/alecthomas/tsk/internal/config"
	"github.com/alecthomas/tsk/internal/engine"
)

const nilScript = `import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";
import * as ast from "go/ast";

export default defineAnalyzer({
  name: "nilident",
  doc: "report nil identifiers",
  requires: [inspect],
  run(pass) {
    const root = pass.resultOf(inspect).root();
    for (const cursor of root.preorder(ast.Ident).filter(pass.typesInfo.isNil)) {
      pass.report({ pos: cursor.node()!.pos(), message: "nil" });
    }
  },
});
`

func load(t testing.TB, scripts map[string]string) *engine.Engine {
	t.Helper()
	return loadWithLogger(t, slog.New(slog.DiscardHandler), scripts)
}

func loadWithLogger(t testing.TB, logger *slog.Logger, scripts map[string]string) *engine.Engine {
	t.Helper()
	e, err := engine.Load(context.Background(), logger, []compile.Source{{Name: "project", FS: mapFS(scripts)}})
	assert.NoError(t, err)
	return e
}

func mapFS(scripts map[string]string) fstest.MapFS {
	files := fstest.MapFS{}
	for name, text := range scripts {
		files[name] = &fstest.MapFile{Data: []byte(text)}
	}
	return files
}

const oneScript = `import { defineAnalyzer } from "tsk";
export default defineAnalyzer({ name: "one", doc: "", run() {} });
`

func TestLibraries(t *testing.T) {
	const helper = `export const message = "from a library";`
	tests := []struct {
		name    string
		sources []compile.Source
		// expected maps each analyzer to its defining module.
		expected map[string]string
		error    string
	}{
		{
			name: "ProjectImportsLibraryByPath",
			sources: []compile.Source{
				{Name: "github.com/acme/a", Library: true, FS: mapFS(map[string]string{"helper.ts": helper, "one.ts": oneScript})},
				{Name: "project", FS: mapFS(map[string]string{"main.ts": `import { defineAnalyzer } from "tsk";
import { message } from "github.com/acme/a/helper";
export default defineAnalyzer({ name: message.length > 0 ? "main" : "", doc: "", run() {} });
`})},
			},
			expected: map[string]string{"one": "github.com/acme/a/one.ts", "main": "project/main.ts"},
		},
		{
			name: "ProjectOverridesLibrary",
			sources: []compile.Source{
				{Name: "github.com/acme/a", Library: true, FS: mapFS(map[string]string{"one.ts": oneScript})},
				{Name: "project", FS: mapFS(map[string]string{"one.ts": oneScript})},
			},
			expected: map[string]string{"one": "project/one.ts"},
		},
		{
			name: "LibrariesCollide",
			sources: []compile.Source{
				{Name: "github.com/acme/a", Library: true, FS: mapFS(map[string]string{"one.ts": oneScript})},
				{Name: "github.com/acme/b", Library: true, FS: mapFS(map[string]string{"one.ts": oneScript})},
			},
			error: "analyzer one is defined by both libraries github.com/acme/a and github.com/acme/b",
		},
		{
			name: "LibraryImportsLibrary",
			sources: []compile.Source{
				{Name: "github.com/acme/a", Library: true, FS: mapFS(map[string]string{"helper.ts": helper})},
				{Name: "github.com/acme/b", Library: true, FS: mapFS(map[string]string{"main.ts": `import { message } from "github.com/acme/a/helper";
export const copied = message;
`})},
			},
			error: `github.com/acme/b/main.ts imports "github.com/acme/a/helper" by path; a library may import only its own scripts, by relative path`,
		},
		{
			name: "NestedSources",
			sources: []compile.Source{
				{Name: "github.com/acme/a", Library: true, FS: mapFS(nil)},
				{Name: "github.com/acme/a/x", Library: true, FS: mapFS(nil)},
			},
			error: "script sources github.com/acme/a and github.com/acme/a/x overlap",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			e, err := engine.Load(t.Context(), slog.New(slog.DiscardHandler), test.sources)
			if test.error != "" {
				assert.Error(t, err)
				assert.Contains(t, err.Error(), test.error)
				return
			}
			assert.NoError(t, err)
			described, err := e.Describe()
			assert.NoError(t, err)
			modules := map[string]string{}
			for _, analyzer := range described {
				modules[analyzer.Name] = analyzer.Source
			}
			assert.Equal(t, test.expected, modules)
		})
	}
}

func TestNilIdentifiers(t *testing.T) {
	e := load(t, map[string]string{"nilident.ts": nilScript})
	analyzers, err := e.Analyzers(config.File{}, nil)
	assert.NoError(t, err)
	dir, cleanup, err := analysistest.WriteFiles(map[string]string{
		"example/example.go": `package example

func f() *int {
	var p *int = nil // want "nil"
	_ = p
	return nil // want "nil"
}
`,
	})
	assert.NoError(t, err)
	defer cleanup()
	analysistest.Run(t, dir, analyzers[0], "example")
}

const iterableScript = `import { defineAnalyzer, not } from "tsk";
import { inspect } from "tsk/passes";
import * as ast from "go/ast";

export default defineAnalyzer({
  name: "iterable",
  doc: "report how GoIterable behaves",
  requires: [inspect],
  run(pass) {
    const root = pass.resultOf(inspect).root();
    const idents = () => root.preorder(ast.Ident);
    const started = idents();
    started.next();
    const drained = idents();
    drained.toArray();
    const checks = [
      idents().map((cursor) => (cursor.node() as ast.Ident).name).toArray().join(" ") === "example v int nil",
      idents().some((cursor) => (cursor.node() as ast.Ident).name === "nil"),
      idents().take(2).toArray().length === 2,
      idents().filter(pass.typesInfo.isNil).toArray().length === 1,
      started.filter(not(pass.typesInfo.isNil)).toArray().length === 2,
      drained.toArray().length === 0,
    ];
    pass.report({ pos: pass.files[0].package, message: "checks: " + checks.join(",") });
  },
});
`

func TestGoIterable(t *testing.T) {
	e := load(t, map[string]string{"iterable.ts": iterableScript})
	analyzers, err := e.Analyzers(config.File{}, nil)
	assert.NoError(t, err)
	dir, cleanup, err := analysistest.WriteFiles(map[string]string{
		"example/example.go": "package example // want \"checks: true,true,true,true,true,true\"\n\nvar v *int = nil\n",
	})
	assert.NoError(t, err)
	defer cleanup()
	analysistest.Run(t, dir, analyzers[0], "example")
}

const visitorScript = `import { defineAnalyzer } from "tsk";
import { inspect } from "tsk/passes";
import * as ast from "go/ast";

export default defineAnalyzer({
  name: "visitor",
  doc: "report the nodes visitors see",
  requires: [inspect],
  run(pass) {
    const file = pass.files[0];
    const events: string[] = [];
    ast.inspect(file, (node) => {
      events.push(node === null ? "pop" : node.$type);
      return node?.$type !== "FuncDecl";
    });
    const idents: string[] = [];
    pass.resultOf(inspect).root().inspect([ast.FuncDecl, ast.Ident], (cursor) => {
      const node = cursor.node()!;
      if (node.$type === "Ident") {
        idents.push(node.name);
      }
      return node.$type !== "FuncDecl";
    });
    pass.report({ pos: file.package, message: events.join(" ") + "; " + idents.join(" ") });
  },
});
`

func TestVisitors(t *testing.T) {
	e := load(t, map[string]string{"visitor.ts": visitorScript})
	analyzers, err := e.Analyzers(config.File{}, nil)
	assert.NoError(t, err)
	dir, cleanup, err := analysistest.WriteFiles(map[string]string{
		"example/example.go": `package example // want "File Ident pop GenDecl ValueSpec Ident pop Ident pop pop pop FuncDecl pop; example v int"

var v int

func f() { _ = v }
`,
	})
	assert.NoError(t, err)
	defer cleanup()
	analysistest.Run(t, dir, analyzers[0], "example")
}

func TestDisableAllEnable(t *testing.T) {
	e := load(t, map[string]string{"nilident.ts": nilScript, "chatty.ts": consoleScript})
	analyzers, err := e.Analyzers(config.File{DisableAll: true, Enable: []string{"chatty"}}, nil)
	assert.NoError(t, err)
	names := make([]string, len(analyzers))
	for i, analyzer := range analyzers {
		names[i] = analyzer.Name
	}
	assert.Equal(t, []string{"chatty"}, names)
	_, err = e.Analyzers(config.File{DisableAll: true, Enable: []string{"missing"}}, nil)
	assert.EqualError(t, err, "enable names unknown analyzer missing")
}

const ssaScript = `import { defineAnalyzer } from "tsk";
import { buildssa } from "tsk/passes";

export default defineAnalyzer({
  name: "ssacalls",
  doc: "report each call's callee and operands, and whether the result is used",
  requires: [buildssa],
  run(pass) {
    for (const fn of pass.resultOf(buildssa).srcFuncs) {
      for (const block of fn!.blocks) {
        for (const instr of block!.instrs) {
          if (instr?.$type !== "Call") {
            continue;
          }
          const operands = instr.operands([]).map((operand) => operand?.name()).join(" ");
          const used = instr.referrers().length > 0;
          pass.report({ pos: instr.pos(), message: instr.call.value!.name() + "(" + operands + ") used=" + used });
        }
      }
    }
  },
});
`

func TestSSA(t *testing.T) {
	e := load(t, map[string]string{"ssacalls.ts": ssaScript})
	analyzers, err := e.Analyzers(config.File{}, nil)
	assert.NoError(t, err)
	dir, cleanup, err := analysistest.WriteFiles(map[string]string{
		"example/example.go": `package example

func double(n int) int { return n * 2 }

func f(n int) int {
	double(n) // want "double\\(double n\\) used=false"
	return double(n) // want "double\\(double n\\) used=true"
}
`,
	})
	assert.NoError(t, err)
	defer cleanup()
	analysistest.Run(t, dir, analyzers[0], "example")
}

const ctrlflowScript = `import { defineAnalyzer } from "tsk";
import { ctrlflow, inspect } from "tsk/passes";
import * as ast from "go/ast";

export default defineAnalyzer({
  name: "returns",
  doc: "report how many blocks of each function return",
  requires: [ctrlflow, inspect],
  run(pass) {
    const cfgs = pass.resultOf(ctrlflow);
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.FuncDecl)) {
      const fn = cursor.node() as ast.FuncDecl;
      const returns = cfgs.funcDecl(fn)!.blocks.filter((block) => block!.return() !== null).length;
      pass.report({ pos: fn.name!.pos(), message: "returns=" + returns });
    }
  },
});
`

func TestCtrlflow(t *testing.T) {
	e := load(t, map[string]string{"returns.ts": ctrlflowScript})
	analyzers, err := e.Analyzers(config.File{}, nil)
	assert.NoError(t, err)
	dir, cleanup, err := analysistest.WriteFiles(map[string]string{
		"example/example.go": `package example

func abs(n int) int { // want "returns=2"
	if n < 0 {
		return -n
	}
	return n
}
`,
	})
	assert.NoError(t, err)
	defer cleanup()
	analysistest.Run(t, dir, analyzers[0], "example")
}

const parserScript = `import { defineAnalyzer } from "tsk";
import * as parser from "go/parser";
import * as token from "go/token";

export default defineAnalyzer({
  name: "reparse",
  doc: "report the comments of each file parsed again from disk",
  run(pass) {
    for (const file of pass.files) {
      const filename = pass.fset.position(file!.pos()).filename;
      const parsed = parser.parseFile(token.newFileSet(), filename, null, parser.ParseComments)!;
      pass.report({ pos: file!.pos(), message: "comments=" + parsed.comments.length });
    }
  },
});
`

func TestParser(t *testing.T) {
	e := load(t, map[string]string{"reparse.ts": parserScript})
	analyzers, err := e.Analyzers(config.File{}, nil)
	assert.NoError(t, err)
	dir, cleanup, err := analysistest.WriteFiles(map[string]string{
		"example/example.go": "package example // want \"comments=2\"\n\n// A comment.\nvar x = 1\n",
	})
	assert.NoError(t, err)
	defer cleanup()
	analysistest.Run(t, dir, analyzers[0], "example")
}

const readsScript = `import { defineAnalyzer } from "tsk";
import * as os from "os";
import * as parser from "go/parser";
import * as filepath from "path/filepath";
import * as token from "go/token";

export default defineAnalyzer({
  name: "reads",
  doc: "report a note beside the package, read in several ways",
  run(pass) {
    const file = pass.files[0]!;
    const dir = filepath.dir(pass.fset.file(file.fileStart)!.name());
    const note = filepath.join(dir, "note.txt");
    const parsed = parser.parseFile(token.newFileSet(), pass.fset.file(file.fileStart)!.name(), null, 0)!;
    const sizes = os.readDir(dir).filter((entry) => entry!.name() === "note.txt").map((entry) => entry!.info()!.size());
    pass.report({ pos: file.pos(), message: os.readFile(note).trim() + " " + parsed.name!.name + " " + sizes.join() });
  },
});
`

// Scripts' file system reads are recorded for the package being analysed,
// including those made through parser.parseFile and directory entries.
func TestTrackedReads(t *testing.T) {
	e := load(t, map[string]string{"reads.ts": readsScript})
	analyzers, err := e.Analyzers(config.File{}, nil)
	assert.NoError(t, err)
	dir, cleanup, err := analysistest.WriteFiles(map[string]string{
		"example/example.go": "package example // want \"hello example 6\"\n",
		"example/note.txt":   "hello\n",
	})
	assert.NoError(t, err)
	defer cleanup()
	analysistest.Run(t, dir, analyzers[0], "example")

	pkgDir := filepath.Join(dir, "src", "example")
	var calls []string
	for _, observation := range e.Recorder().Observations([]string{"example"}) {
		calls = append(calls, observation.Call.Func+" "+observation.Call.Args)
	}
	quote := strconv.Quote
	assert.Equal(t, []string{
		"os.Lstat [" + quote(filepath.Join(pkgDir, "note.txt")) + "]",
		"os.ReadDir [" + quote(pkgDir) + "]",
		"os.ReadFile [" + quote(filepath.Join(pkgDir, "example.go")) + "]",
		"os.ReadFile [" + quote(filepath.Join(pkgDir, "note.txt")) + "]",
	}, calls)
	assert.Equal(t, 0, len(e.Recorder().Observations([]string{"other"})))
}

// Reads outside an analyzer run cannot be attributed to a package.
func TestReadOutsideRun(t *testing.T) {
	script := `import { defineAnalyzer } from "tsk";
import * as os from "os";
os.getwd();
export default defineAnalyzer({ name: "early", doc: "", run() {} });
`
	_, err := engine.Load(context.Background(), slog.New(slog.DiscardHandler), []compile.Source{{Name: "project", FS: mapFS(map[string]string{"early.ts": script})}})
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "os.getwd reads the file system, which scripts may do only while an analyzer runs")
}

const formatScript = `import { defineAnalyzer, formatNode } from "tsk";
import { inspect } from "tsk/passes";
import * as ast from "go/ast";

export default defineAnalyzer({
  name: "format",
  doc: "report how each return value formats",
  requires: [inspect],
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.ReturnStmt)) {
      const value = (cursor.node() as ast.ReturnStmt).results[0]!;
      pass.report({ pos: value.pos(), message: formatNode(value) + " | " + formatNode(value, pass.fset) });
    }
  },
});
`

func TestFormatNode(t *testing.T) {
	e := load(t, map[string]string{"format.ts": formatScript})
	analyzers, err := e.Analyzers(config.File{}, nil)
	assert.NoError(t, err)
	dir, cleanup, err := analysistest.WriteFiles(map[string]string{
		"example/example.go": "package example\n\n" +
			"func f(a, b, c int) int {\n\treturn a + b*c // want `^a \\+ b\\*c \\| a \\+ b\\*c$`\n}\n\n" +
			"func g() []int {\n\treturn []int{ // want `^\\[\\]int\\{1, 2\\} \\| \\[\\]int\\{\\n\\t1,\\n\\t2,\\n\\}$`\n\t\t1,\n\t\t2,\n\t}\n}\n",
	})
	assert.NoError(t, err)
	defer cleanup()
	analysistest.Run(t, dir, analyzers[0], "example")
}

// filesScript reports every file, at its package clause.
func filesScript(definition string) string {
	return `import { defineAnalyzer } from "tsk";

export default defineAnalyzer({
  name: "files",
  doc: "report every file",
  ` + definition + `
  run(pass) {
    for (const file of pass.files) {
      pass.report({ pos: file.package, message: "file" });
    }
  },
});
`
}

// An analyzer that checks //nolint comments opts out of their suppression.
func TestNolintOption(t *testing.T) {
	tests := []struct {
		Name       string
		Definition string
		Source     string
	}{
		{Name: "Suppressed", Source: "package example //nolint\n"},
		{Name: "OptedOut", Definition: "nolint: false,", Source: "package example /* want \"file\" */ //nolint\n"},
	}
	for _, test := range tests {
		t.Run(test.Name, func(t *testing.T) {
			e := load(t, map[string]string{"files.ts": filesScript(test.Definition)})
			analyzers, err := e.Analyzers(config.File{}, nil)
			assert.NoError(t, err)
			dir, cleanup, err := analysistest.WriteFiles(map[string]string{"example/example.go": test.Source})
			assert.NoError(t, err)
			defer cleanup()
			analysistest.Run(t, dir, analyzers[0], "example")
		})
	}
}

func TestReportFilters(t *testing.T) {
	const reported = `package example // want "file"` + "\n"
	const silent = "package example\n"
	const generatedHeader = "// Code generated by hand. DO NOT EDIT.\n\n"
	tests := []struct {
		Name       string
		Definition string
		File       config.File
		// Generated and Test are the expected contents of a generated file and
		// a test file; plain files are always reported.
		Generated string
		Test      string
	}{
		{Name: "Default", Generated: generatedHeader + silent, Test: reported},
		// Without a test file, analysistest generates no test main, which is
		// itself a generated file.
		{Name: "LintGenerated", File: config.File{LintGenerated: true}, Generated: generatedHeader + reported},
		{Name: "NoTests", File: config.File{NoTests: true}, Generated: generatedHeader + silent, Test: silent},
		{Name: "SkipTests", File: config.File{SkipTests: []string{"files"}}, Generated: generatedHeader + silent, Test: silent},
		{Name: "AnalyzerSkipsTests", Definition: "tests: false,", Generated: generatedHeader + silent, Test: silent},
	}
	for _, test := range tests {
		t.Run(test.Name, func(t *testing.T) {
			e := load(t, map[string]string{"files.ts": filesScript(test.Definition)})
			analyzers, err := e.Analyzers(test.File, nil)
			assert.NoError(t, err)
			files := map[string]string{
				"example/plain.go":     reported,
				"example/generated.go": test.Generated,
				// Only Go's convention marks a file generated, as in golangci-lint's default.
				"example/loose.go": "/* Code generated by hand; DO NOT EDIT. */\n" + reported,
			}
			if test.Test != "" {
				files["example/example_test.go"] = test.Test
			}
			dir, cleanup, err := analysistest.WriteFiles(files)
			assert.NoError(t, err)
			defer cleanup()
			analysistest.Run(t, dir, analyzers[0], "example")
		})
	}
}

func TestSkipTestsNamesUnknownAnalyzer(t *testing.T) {
	e := load(t, map[string]string{"files.ts": filesScript("")})
	_, err := e.Analyzers(config.File{SkipTests: []string{"missing"}}, nil)
	assert.EqualError(t, err, "skip-tests names unknown analyzer missing")
}

const documentedScript = `import { defineAnalyzer } from "tsk";

interface Config {
  /** How many to allow. */
  limit: number;
}

export default defineAnalyzer<Config>({
  name: "documented",
  doc: "has documented config",
  config: { limit: 3 },
  run() {},
});
`

func TestDescribe(t *testing.T) {
	e := load(t, map[string]string{"documented.ts": documentedScript, "nilident.ts": nilScript})
	described, err := e.Describe()
	assert.NoError(t, err)
	assert.Equal(t, 2, len(described))
	documented, plain := described[0], described[1]
	assert.Equal(t, "project/documented.ts", documented.Source)
	config, ok := documented.Config.Get()
	assert.True(t, ok)
	assert.Equal(t, ts.Shape(ts.ObjectShape{Properties: []ts.Property{
		{Name: "limit", Doc: "How many to allow.", Shape: ts.NumberShape{}},
	}}), config.Shape)
	assert.Equal(t, any(map[string]any{"limit": 3.0}), config.Defaults)
	assert.Equal(t, "project/nilident.ts", plain.Source)
	_, ok = plain.Config.Get()
	assert.False(t, ok)
}

const errorScript = `import { defineAnalyzer, GoError } from "tsk";
import * as fs from "io/fs";
import * as os from "os";
import * as filepath from "path/filepath";

export default defineAnalyzer({
  name: "missingfile",
  doc: "report how a missing file's error is classified",
  run(pass) {
    try {
      os.readFile(filepath.join(os.getwd(), "does-not-exist"));
    } catch (e) {
      const checks = [
        e instanceof os.ErrNotExist,
        e instanceof fs.ErrNotExist,
        !(e instanceof fs.ErrPermission),
        e instanceof GoError,
        e instanceof Error,
        e instanceof fs.PathError && e.op === "open" && e.path.endsWith("does-not-exist"),
        e instanceof Error && e.message.includes("no such file"),
      ];
      pass.report({ pos: pass.files[0].package, message: "checks: " + checks.join(",") });
    }
  },
});
`

func TestGoErrorClasses(t *testing.T) {
	e := load(t, map[string]string{"missingfile.ts": errorScript})
	analyzers, err := e.Analyzers(config.File{}, nil)
	assert.NoError(t, err)
	dir, cleanup, err := analysistest.WriteFiles(map[string]string{
		"example/example.go": "package example // want \"checks: true,true,true,true,true,true,true\"\n",
	})
	assert.NoError(t, err)
	defer cleanup()
	analysistest.Run(t, dir, analyzers[0], "example")
}

const errorListScript = `import { defineAnalyzer, GoError } from "tsk";
import * as modfile from "golang.org/x/mod/modfile";

export default defineAnalyzer({
  name: "badgomod",
  doc: "report how a go.mod parse failure is classified",
  run(pass) {
    try {
      modfile.parse("go.mod", "module x\nbogus directive\n", null);
    } catch (e) {
      const checks = [
        e instanceof modfile.ErrorList,
        e instanceof GoError,
        e instanceof modfile.ErrorList && e.length === 1,
        e instanceof modfile.ErrorList && e.at(0) instanceof modfile.Error && e.at(0)!.pos.line === 2,
        e instanceof modfile.ErrorList && [...e].every((item) => item instanceof GoError),
      ];
      pass.report({ pos: pass.files[0].package, message: "checks: " + checks.join(",") });
    }
  },
});
`

func TestGoErrorListClass(t *testing.T) {
	e := load(t, map[string]string{"badgomod.ts": errorListScript})
	analyzers, err := e.Analyzers(config.File{}, nil)
	assert.NoError(t, err)
	dir, cleanup, err := analysistest.WriteFiles(map[string]string{
		"example/example.go": "package example // want \"checks: true,true,true,true,true\"\n",
	})
	assert.NoError(t, err)
	defer cleanup()
	analysistest.Run(t, dir, analyzers[0], "example")
}

// consoleScript logs only from run: top-level code runs again in every
// runtime the pool creates in the background, at unpredictable times.
const consoleScript = `import { defineAnalyzer } from "tsk";

export default defineAnalyzer({
  name: "chatty",
  doc: "write to the console",
  run(pass) {
    console.warn("warning");
    console.log("hello", 42);
    console.debug("detail");
  },
});
`

func TestConsoleWritesToLogger(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&output, &slog.HandlerOptions{
		Level: slog.LevelInfo,
		ReplaceAttr: func(_ []string, attr slog.Attr) slog.Attr {
			if attr.Key == slog.TimeKey || attr.Key == "duration" || attr.Key == "analyzers" {
				return slog.Attr{}
			}
			return attr
		},
	}))
	e := loadWithLogger(t, logger, map[string]string{"chatty.ts": consoleScript})
	analyzers, err := e.Analyzers(config.File{}, nil)
	assert.NoError(t, err)
	dir, cleanup, err := analysistest.WriteFiles(map[string]string{"example/example.go": "package example\n"})
	assert.NoError(t, err)
	defer cleanup()
	analysistest.Run(t, dir, analyzers[0], "example")
	assert.Equal(t, strings.Join([]string{
		`level=INFO msg="Loaded analyzers"`,
		`level=INFO msg="Loaded packages"`,
		`level=WARN msg=warning analyzer=chatty package=example`,
		`level=INFO msg="hello 42" analyzer=chatty package=example`,
		``,
	}, "\n"), output.String())
}

// lockedBuffer is a log destination safe to read while background runtime
// creation may still be writing to it.
type lockedBuffer struct {
	lock   sync.Mutex
	buffer bytes.Buffer
}

func (b *lockedBuffer) Write(data []byte) (int, error) {
	b.lock.Lock()
	defer b.lock.Unlock()
	return b.buffer.Write(data) //nolint:wrapcheck // bytes.Buffer never fails.
}

func (b *lockedBuffer) String() string {
	b.lock.Lock()
	defer b.lock.Unlock()
	return b.buffer.String()
}

func TestPoolWarmsRuntimesInBackground(t *testing.T) {
	output := &lockedBuffer{}
	logger := slog.New(slog.NewTextHandler(output, &slog.HandlerOptions{Level: slog.LevelDebug}))
	loadWithLogger(t, logger, map[string]string{"nilident.ts": nilScript})
	// The bootstrap runtime is one of the buffer; warming creates the other.
	deadline := time.Now().Add(10 * time.Second)
	for !strings.Contains(output.String(), `msg="Created runtime"`) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	assert.Contains(t, output.String(), "background=true")
}
