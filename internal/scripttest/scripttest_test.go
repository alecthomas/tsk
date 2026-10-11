package scripttest_test

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/alecthomas/assert/v2"
	"github.com/alecthomas/errors"

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

// setup writes testdata for analyzers alpha and beta, where one of alpha's
// cases fails, and returns the scripts directory and engine.
func setup(t *testing.T) (string, *engine.Engine) {
	t.Helper()
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
	return scripts, e
}

func TestRunAllReportsEveryCase(t *testing.T) {
	scripts, e := setup(t)
	var out bytes.Buffer
	err := scripttest.RunAll(e, e.Names(), scripts, &out, scripttest.Config{}, noIsolate(t))
	assert.EqualError(t, err, "1 of 4 cases failed")

	// Cases report as they finish, in any order; failure details follow
	// their case.
	var results []string
	for line := range strings.SplitSeq(strings.TrimSpace(out.String()), "\n") {
		if strings.HasPrefix(line, "ok") || strings.HasPrefix(line, "FAIL") {
			results = append(results, line)
		}
	}
	slices.Sort(results)
	assert.Equal(t, []string{
		"FAIL alpha/bad",
		"ok   alpha/also-good",
		"ok   alpha/good",
		"ok   beta/good",
	}, results)
	assert.Contains(t, out.String(), "FAIL alpha/bad\n     ")

	// Only the named analyzers' cases run.
	out.Reset()
	assert.NoError(t, scripttest.RunAll(e, []string{"beta"}, scripts, &out, scripttest.Config{}, noIsolate(t)))
	assert.Equal(t, "ok   beta/good\n", out.String())
}

// noIsolate fails the test if a case runs in its own process.
func noIsolate(t *testing.T) scripttest.Isolate {
	t.Helper()
	return func(name string, _ []string) ([]byte, error) {
		t.Errorf("case %s ran in its own process", name)
		return nil, nil
	}
}

// A case setting a target platform runs in its own process, given the target
// in its environment; that process runs only the named case.
func TestRunAllIsolatesTargetedCases(t *testing.T) {
	scripts, e := setup(t)
	cases := "[[case]]\nname = \"good\"\npackages = [\"c\"]\n\n" +
		"[[case]]\nname = \"arm\"\npackages = [\"c\"]\ngoos = \"linux\"\ngoarch = \"arm\"\n"
	assert.NoError(t, os.WriteFile(filepath.Join(scripts, "testdata/beta/tsk.test.toml"), []byte(cases), 0o600))

	var isolated []string
	isolate := func(name string, env []string) ([]byte, error) {
		isolated = append(isolated, name+" "+strings.Join(env, " "))
		// A failing case's process exits with an error after its output.
		return []byte(`{"event":"start","analyzer":"beta"}` + "\n" +
			`{"analyzer":"beta","case":"arm","passed":false,"failures":["boom"],"duration":1}` + "\n"), errors.New("exit status 1")
	}
	var out bytes.Buffer
	err := scripttest.RunAll(e, []string{"beta"}, scripts, &out, scripttest.Config{}, isolate)
	assert.EqualError(t, err, "1 of 2 cases failed")
	assert.Equal(t, []string{"beta/arm GOOS=linux GOARCH=arm"}, isolated)
	assert.Contains(t, out.String(), "FAIL beta/arm\n     boom\n")
	assert.Contains(t, out.String(), "ok   beta/good\n")

	// The isolated process runs the named case itself.
	out.Reset()
	assert.NoError(t, scripttest.RunAll(e, []string{"beta"}, scripts, &out, scripttest.Config{Case: "beta/arm"}, noIsolate(t)))
	assert.Equal(t, "ok   beta/arm\n", out.String())
}

// result is a line of JSON output: an event or a case's result.
type result struct {
	Event    string   `json:"event"`
	Analyzer string   `json:"analyzer"`
	Case     string   `json:"case"`
	Passed   bool     `json:"passed"`
	Failures []string `json:"failures"`
	Duration float64  `json:"duration"`
}

func TestRunAllJSON(t *testing.T) {
	scripts, e := setup(t)
	var out bytes.Buffer
	err := scripttest.RunAll(e, e.Names(), scripts, &out, scripttest.Config{JSON: true}, noIsolate(t))
	assert.EqualError(t, err, "1 of 4 cases failed")

	var lines []result
	for line := range strings.SplitSeq(strings.TrimSpace(out.String()), "\n") {
		var r result
		assert.NoError(t, json.Unmarshal([]byte(line), &r))
		// Results and end events carry a duration; start events do not.
		assert.Equal(t, r.Event != "start", r.Duration > 0, line)
		lines = append(lines, r)
	}
	// Each analyzer's results sit between its start and end events, though
	// analyzers' results may interleave.
	var results []result
	for _, analyzer := range []string{"alpha", "beta"} {
		var events []string
		for _, line := range lines {
			switch {
			case line.Analyzer != analyzer:
			case line.Event != "":
				events = append(events, line.Event)
			default:
				events = append(events, "result")
				results = append(results, line)
			}
		}
		expected := slices.Repeat([]string{"result"}, len(events)-2)
		assert.Equal(t, slices.Concat([]string{"start"}, expected, []string{"end"}), events, analyzer)
	}
	slices.SortFunc(results, func(a, b result) int {
		return cmp.Or(strings.Compare(a.Analyzer, b.Analyzer), strings.Compare(a.Case, b.Case))
	})
	assert.Equal(t, []result{
		{Analyzer: "alpha", Case: "also-good", Passed: true},
		{Analyzer: "alpha", Case: "bad"},
		{Analyzer: "alpha", Case: "good", Passed: true},
		{Analyzer: "beta", Case: "good", Passed: true},
	}, results, assert.Exclude[[]string](), assert.Exclude[float64]())
	assert.NotZero(t, len(results[1].Failures))
}
