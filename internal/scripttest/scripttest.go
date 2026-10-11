// Package scripttest runs analysistest against script analyzers, using
// testdata beside the scripts.
package scripttest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

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
	// GOOS and GOARCH, when set, load the packages for that target platform
	// instead of the host's, as go env would report them.
	GOOS   string `toml:"goos"`
	GOARCH string `toml:"goarch"`
}

// targeted reports whether the case sets its own target platform.
func (c Case) targeted() bool {
	return c.GOOS != "" || c.GOARCH != ""
}

// Isolate runs tsk test for one case, named analyzer/case, in a new process
// with env added to its environment, and returns its JSON output.
type Isolate func(name string, env []string) ([]byte, error)

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
	// Enabling the analyzer runs it even when it is off by default.
	file := config.File{Enable: []string{analyzer}, Tables: map[string]map[string]any{analyzer: c.Config}}
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
	duration time.Duration
}

// Config holds the options for running every case.
type Config struct {
	JSON bool `help:"Print each case's result as a line of JSON."`
	// Case is set for the process that runs a targeted case, which must not
	// isolate it again.
	Case string `hidden:"" help:"Run only this case, named analyzer/case, in this process."`
}

// result is a case's result as JSON.
type result struct {
	Analyzer string   `json:"analyzer"`
	Case     string   `json:"case"`
	Passed   bool     `json:"passed"`
	Failures []string `json:"failures,omitzero"`
	// Duration is in seconds.
	Duration float64 `json:"duration"`
}

// event marks, in JSON output, where an analyzer's results start or end.
type event struct {
	Event    string `json:"event"`
	Analyzer string `json:"analyzer"`
	// Duration, in seconds, runs from the analyzer's first case starting to
	// its last finishing. Only end events have one.
	Duration float64 `json:"duration,omitzero"`
}

// RunAll runs every case of the named analyzers with testdata under the
// scripts directory concurrently, writing each case's result to out as soon
// as it finishes. Cases setting a target platform run through isolate.
func RunAll(e *engine.Engine, analyzers []string, scripts string, out io.Writer, config Config, isolate Isolate) error {
	var all []*analyzerCase
	// remaining counts each analyzer's unreported cases, so JSON output can
	// mark its first and last results.
	remaining := map[string]int{}
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
			if config.Case != "" && config.Case != analyzer+"/"+c.Name {
				continue
			}
			all = append(all, &analyzerCase{analyzer: analyzer, dir: dir, c: c, recorder: newRecorder()})
			remaining[analyzer]++
		}
	}
	total := maps.Clone(remaining)
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
	// The mutex keeps each case's lines together in out and guards failed,
	// remaining, and started.
	var mu sync.Mutex
	failed := 0
	// started holds when each analyzer's first case started.
	started := map[string]time.Time{}
	for _, ac := range all {
		group.Go(func() error {
			start := time.Now()
			mu.Lock()
			if _, ok := started[ac.analyzer]; !ok {
				started[ac.analyzer] = start
			}
			mu.Unlock()
			run := func() error { return Run(ac.recorder, e, ac.analyzer, ac.dir, ac.c) }
			if ac.c.targeted() && config.Case == "" {
				run = func() error { return runIsolated(isolate, ac) }
			}
			if err := run(); err != nil {
				return err
			}
			ac.duration = time.Since(start)
			mu.Lock()
			defer mu.Unlock()
			if len(ac.recorder.Failures()) > 0 {
				failed++
			}
			first := remaining[ac.analyzer] == total[ac.analyzer]
			remaining[ac.analyzer]--
			if config.JSON && first {
				if err := writeJSON(out, event{Event: "start", Analyzer: ac.analyzer}); err != nil {
					return err
				}
			}
			if err := report(out, ac, config); err != nil {
				return err
			}
			if config.JSON && remaining[ac.analyzer] == 0 {
				return writeJSON(out, event{Event: "end", Analyzer: ac.analyzer, Duration: time.Since(started[ac.analyzer]).Seconds()})
			}
			return nil
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

// runIsolated runs a case that sets a target platform in its own process,
// because analysistest loads packages with the process's environment, and
// records the failures that process reports.
func runIsolated(isolate Isolate, ac *analyzerCase) error {
	var env []string
	if ac.c.GOOS != "" {
		env = append(env, "GOOS="+ac.c.GOOS)
	}
	if ac.c.GOARCH != "" {
		env = append(env, "GOARCH="+ac.c.GOARCH)
	}
	name := ac.analyzer + "/" + ac.c.Name
	// A failing case makes the process exit with an error, so its output is
	// read before the error is.
	out, runErr := isolate(name, env)
	decoder := json.NewDecoder(bytes.NewReader(out))
	for decoder.More() {
		var r result
		if err := decoder.Decode(&r); err != nil {
			break
		}
		if r.Analyzer == ac.analyzer && r.Case == ac.c.Name {
			for _, failure := range r.Failures {
				ac.recorder.Errorf("%s", failure)
			}
			return nil
		}
	}
	var stderr []byte
	if exit := (*exec.ExitError)(nil); errors.As(runErr, &exit) {
		stderr = exit.Stderr
	}
	return errors.Errorf("case %s: no result from its process: %v\n%s", name, runErr, stderr)
}

// report writes a case's result, with its failures if any, to out.
func report(out io.Writer, ac *analyzerCase, config Config) error {
	failures := ac.recorder.Failures()
	if config.JSON {
		return writeJSON(out, result{Analyzer: ac.analyzer, Case: ac.c.Name, Passed: len(failures) == 0, Failures: failures, Duration: ac.duration.Seconds()})
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

// writeJSON writes value to out as one line of JSON.
func writeJSON(out io.Writer, value any) error {
	return errors.Wrap(json.NewEncoder(out).Encode(value), "write result")
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
