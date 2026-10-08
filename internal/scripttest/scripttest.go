// Package scripttest runs analysistest against script analyzers, using
// testdata beside the scripts.
package scripttest

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/alecthomas/errors"
	"github.com/pelletier/go-toml/v2"
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

// RunAll runs every case of every analyzer with testdata under the scripts
// directory, writing one result line per case to out.
func RunAll(e *engine.Engine, scripts string, out io.Writer) error {
	failed, tested := 0, 0
	for _, analyzer := range e.Names() {
		dir := Dir(scripts, analyzer)
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		cases, err := Cases(dir)
		if err != nil {
			return err
		}
		for _, c := range cases {
			tested++
			recorder := newRecorder()
			if err := Run(recorder, e, analyzer, dir, c); err != nil {
				return err
			}
			if len(recorder.Failures()) == 0 {
				fmt.Fprintf(out, "ok   %s/%s\n", analyzer, c.Name) //nolint:errcheck // Output is best effort.
				continue
			}
			failed++
			fmt.Fprintf(out, "FAIL %s/%s\n", analyzer, c.Name) //nolint:errcheck // Output is best effort.
			for _, failure := range recorder.Failures() {
				fmt.Fprintln(out, "     "+strings.ReplaceAll(failure, "\n", "\n     ")) //nolint:errcheck // Output is best effort.
			}
		}
	}
	if tested == 0 {
		return errors.Errorf("no testdata found under %s", filepath.Join(scripts, "testdata"))
	}
	if failed > 0 {
		return errors.Errorf("%d of %d cases failed", failed, tested)
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
