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

	"github.com/alecthomas/tsktsk/internal/compile"
	"github.com/alecthomas/tsktsk/internal/config"
	"github.com/alecthomas/tsktsk/internal/engine"
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
	files := fstest.MapFS{}
	for name, text := range scripts {
		files[name] = &fstest.MapFile{Data: []byte(text)}
	}
	e, err := engine.Load(context.Background(), logger, []compile.Source{{Name: "project", FS: files}})
	assert.NoError(t, err)
	return e
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
