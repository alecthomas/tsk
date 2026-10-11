// Package scripttest runs analysistest against script analyzers, using
// testdata beside the scripts.
package scripttest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/alecthomas/errors"
	"github.com/pelletier/go-toml/v2"
	"golang.org/x/sync/errgroup"
	"golang.org/x/tools/go/analysis"
	"golang.org/x/tools/go/analysis/analysistest"

	"github.com/alecthomas/tsk/internal/config"
	"github.com/alecthomas/tsk/internal/engine"
)

// CasesFile lists an analyzer's test cases; it sits in the analyzer's testdata.
const CasesFile = "tsk.test.toml"

// Case is one analysistest run with its own config.
type Case struct {
	Name string `toml:"name"`
	// Dir is the case's test data, relative to the analyzer's testdata
	// directory. It defaults to that directory.
	Dir      string         `toml:"dir"`
	Packages []string       `toml:"packages"`
	Config   map[string]any `toml:"config"`
}

// Dir returns an analyzer's testdata directory under a scripts directory.
func Dir(scripts, analyzer string) string {
	return filepath.Join(scripts, "testdata", analyzer)
}

// Cases reads an analyzer's cases. Without a cases file there is one case
// testing every package with the default config.
func Cases(dir string) ([]Case, error) {
	path := filepath.Join(dir, CasesFile)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return []Case{{Name: "default", Packages: []string{"./..."}}}, nil
	}
	if err != nil {
		return nil, errors.Wrapf(err, "read %s", path)
	}
	var file struct {
		Case []Case `toml:"case"`
	}
	// Unknown keys are errors, so a misspelt case field is not ignored.
	if err := toml.NewDecoder(bytes.NewReader(data)).DisallowUnknownFields().Decode(&file); err != nil {
		return nil, errors.Wrapf(err, "read %s", path)
	}
	for i, c := range file.Case {
		if c.Name == "" || len(c.Packages) == 0 {
			return nil, errors.Errorf("%s: case %d needs a name and packages", path, i+1)
		}
	}
	return file.Case, nil
}

// Run runs one case. Failures are reported to t, as analysistest does.
func Run(t analysistest.Testing, e *engine.Engine, analyzer, dir string, c Case) error {
	file := config.File{Tables: map[string]map[string]any{analyzer: c.Config}}
	// Test data is all first-party, so no package is skipped.
	analyzers, err := e.Analyzers(file, nil)
	if err != nil {
		return errors.Wrapf(err, "case %s", c.Name)
	}
	found, ok := find(analyzers, analyzer)
	if !ok {
		return errors.Errorf("unknown analyzer %s", analyzer)
	}
	// GOPATH-style test data needs an absolute path.
	absolute, err := filepath.Abs(filepath.Join(dir, c.Dir))
	if err != nil {
		return errors.Wrap(err, "resolve testdata")
	}
	analysistest.Run(t, absolute, found, c.Packages...)
	return nil
}

func find(analyzers []*analysis.Analyzer, name string) (*analysis.Analyzer, bool) {
	for _, analyzer := range analyzers {
		if analyzer.Name == name {
			return analyzer, true
		}
	}
	return nil, false
}

// analyzerCase is one case of one analyzer, with where its result goes.
type analyzerCase struct {
	analyzer string
	dir      string
	c        Case
	recorder *recorder
}

// Config holds the options for running every case.
type Config struct {
	JSON bool `help:"Print each case's result as a line of JSON."`
}

// result is a case's result as JSON.
type result struct {
	Analyzer string   `json:"analyzer"`
	Case     string   `json:"case"`
	Passed   bool     `json:"passed"`
	Failures []string `json:"failures,omitzero"`
}

// RunAll runs every case of the named analyzers with testdata under the
// scripts directory concurrently, writing each case's result to out as soon
// as it finishes.
func RunAll(e *engine.Engine, analyzers []string, scripts string, out io.Writer, config Config) error {
	var all []*analyzerCase
	for _, analyzer := range analyzers {
		dir := Dir(scripts, analyzer)
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		cases, err := Cases(dir)
		if err != nil {
			return err
		}
		for _, c := range cases {
			all = append(all, &analyzerCase{analyzer: analyzer, dir: dir, c: c, recorder: newRecorder()})
		}
	}
	if len(all) == 0 {
		return errors.Errorf("no testdata found under %s", filepath.Join(scripts, "testdata"))
	}
	// Each case builds its own analyzers, and the engine's runtime pool is
	// safe to share, so cases are independent. Each owns its recorder.
	//
	// Every case type-checks its dependencies from source, so more cases at
	// once mostly add garbage collection; half the CPUs measured fastest.
	var group errgroup.Group
	group.SetLimit(max(1, runtime.GOMAXPROCS(0)/2))
	// The mutex keeps each case's lines together in out and guards failed.
	var mu sync.Mutex
	failed := 0
	for _, ac := range all {
		group.Go(func() error {
			if err := Run(ac.recorder, e, ac.analyzer, ac.dir, ac.c); err != nil {
				return err
			}
			mu.Lock()
			defer mu.Unlock()
			if len(ac.recorder.Failures()) > 0 {
				failed++
			}
			return report(out, ac, config)
		})
	}
	if err := group.Wait(); err != nil {
		return errors.WithStack(err)
	}
	if failed > 0 {
		return errors.Errorf("%d of %d cases failed", failed, len(all))
	}
	return nil
}

// report writes a case's result, with its failures if any, to out.
func report(out io.Writer, ac *analyzerCase, config Config) error {
	failures := ac.recorder.Failures()
	if config.JSON {
		line := result{Analyzer: ac.analyzer, Case: ac.c.Name, Passed: len(failures) == 0, Failures: failures}
		return errors.Wrap(json.NewEncoder(out).Encode(line), "write result")
	}
	if len(failures) == 0 {
		fmt.Fprintf(out, "ok   %s/%s\n", ac.analyzer, ac.c.Name) //nolint:errcheck // Output is best effort.
		return nil
	}
	fmt.Fprintf(out, "FAIL %s/%s\n", ac.analyzer, ac.c.Name) //nolint:errcheck // Output is best effort.
	for _, failure := range failures {
		fmt.Fprintln(out, "     "+strings.ReplaceAll(failure, "\n", "\n     ")) //nolint:errcheck // Output is best effort.
	}
	return nil
}

// recorder collects analysistest failures.
type recorder struct {
	failures []string
}

func newRecorder() *recorder {
	return &recorder{}
}

// Errorf records a failure; it implements analysistest.Testing.
func (r *recorder) Errorf(format string, args ...any) {
	r.failures = append(r.failures, fmt.Sprintf(format, args...))
}

// Failures returns the recorded failures in order.
func (r *recorder) Failures() []string {
	return r.failures
}
