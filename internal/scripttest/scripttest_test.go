package scripttest_test

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/alecthomas/assert/v2"

	"github.com/alecthomas/tsk/internal/compile"
	"github.com/alecthomas/tsk/internal/engine"
	"github.com/alecthomas/tsk/internal/scripttest"
)

const packageScript = `import { defineAnalyzer } from "tsk";

export default defineAnalyzer({
  name: "NAME",
  doc: "report each package's name",
  run(pass) {
    for (const file of pass.files) {
      pass.report({ pos: file!.package, message: "pkg " + pass.pkg.name() });
    }
  },
});
`

func TestRunAllReportsCasesInOrder(t *testing.T) {
	scripts := t.TempDir()
	files := map[string]string{
		"testdata/alpha/tsk.test.toml": "[[case]]\nname = \"good\"\npackages = [\"a\"]\n\n" +
			"[[case]]\nname = \"bad\"\npackages = [\"b\"]\n\n" +
			"[[case]]\nname = \"also-good\"\npackages = [\"a\"]\n",
		"testdata/alpha/src/a/a.go":   "package a // want \"pkg a\"\n",
		"testdata/alpha/src/b/b.go":   "package b // want \"nope\"\n",
		"testdata/beta/tsk.test.toml": "[[case]]\nname = \"good\"\npackages = [\"c\"]\n",
		"testdata/beta/src/c/c.go":    "package c // want \"pkg c\"\n",
	}
	for name, text := range files {
		path := filepath.Join(scripts, name)
		assert.NoError(t, os.MkdirAll(filepath.Dir(path), 0o750))
		assert.NoError(t, os.WriteFile(path, []byte(text), 0o600))
	}
	source := fstest.MapFS{
		"alpha.ts": {Data: []byte(strings.ReplaceAll(packageScript, "NAME", "alpha"))},
		"beta.ts":  {Data: []byte(strings.ReplaceAll(packageScript, "NAME", "beta"))},
	}
	e, err := engine.Load(context.Background(), slog.New(slog.DiscardHandler), []compile.Source{{Name: "project", FS: source}})
	assert.NoError(t, err)

	var out bytes.Buffer
	err = scripttest.RunAll(e, scripts, &out)
	assert.EqualError(t, err, "1 of 4 cases failed")

	// Cases run concurrently but report in declaration order; failure
	// details follow their case.
	var results []string
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if strings.HasPrefix(line, "ok") || strings.HasPrefix(line, "FAIL") {
			results = append(results, line)
		}
	}
	assert.Equal(t, []string{
		"ok   alpha/good",
		"FAIL alpha/bad",
		"ok   alpha/also-good",
		"ok   beta/good",
	}, results)
	assert.Contains(t, out.String(), "FAIL alpha/bad\n     ")
}
