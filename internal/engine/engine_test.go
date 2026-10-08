package engine_test

import (
	"bytes"
	"context"
	"log/slog"
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
