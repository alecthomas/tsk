// Package engine turns linter scripts into go/analysis analyzers.
package engine

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"maps"
	"reflect"
	"slices"
	"sync"
	"time"

	"github.com/alecthomas/errors"
	. "github.com/alecthomas/types/optional"
	ts "github.com/microsoft/TypeScript/tsc/shim/typescript"
	"golang.org/x/tools/go/analysis"
	"golang.org/x/tools/go/analysis/passes/buildssa"
	"golang.org/x/tools/go/analysis/passes/ctrlflow"
	"golang.org/x/tools/go/analysis/passes/inspect"

	"github.com/alecthomas/tsk/internal/compile"
	"github.com/alecthomas/tsk/internal/config"
	"github.com/alecthomas/tsk/internal/docs"
	"github.com/alecthomas/tsk/internal/facts"
	"github.com/alecthomas/tsk/internal/inputs"
	"github.com/alecthomas/tsk/internal/nolint"
	"github.com/alecthomas/tsk/internal/vm"
)

// Engine holds loaded scripts and the runtimes that run them.
type Engine struct {
	program  *compile.Program
	metadata []vm.Metadata
	pool     *pool
	logger   *slog.Logger
	// recorder records what every analyzer run reads from the file system.
	// One engine serves one invocation, so its reads share one view.
	recorder *inputs.Recorder
}

// Load compiles and evaluates sources. Later sources override analyzers of
// the same name in earlier ones, except that two libraries may not define the
// same name. Script console output goes to logger.
func Load(ctx context.Context, logger *slog.Logger, sources []compile.Source) (*Engine, error) {
	start := time.Now()
	program, err := compile.Compile(ctx, sources)
	if err != nil {
		return nil, errors.Wrap(err, "compile scripts")
	}
	logger.DebugContext(ctx, "Compiled scripts", "scripts", len(program.Entries), "duration", time.Since(start))
	parsed := time.Now()
	modules, err := vm.NewModules(program)
	if err != nil {
		return nil, errors.Wrap(err, "load modules")
	}
	logger.DebugContext(ctx, "Parsed modules", "duration", time.Since(parsed))
	evaluated := time.Now()
	bootstrap, err := vm.New(modules, logger)
	if err != nil {
		return nil, errors.Wrap(err, "evaluate scripts")
	}
	logger.DebugContext(ctx, "Evaluated scripts", "duration", time.Since(evaluated))
	for _, name := range bootstrap.Overridden() {
		logger.InfoContext(ctx, "Analyzer overridden by a later definition", "analyzer", name)
	}
	engine := &Engine{program: program, pool: newPool(modules, logger), logger: logger, recorder: inputs.NewRecorder()}
	for _, name := range bootstrap.Analyzers() {
		metadata, err := bootstrap.Metadata(name)
		if err != nil {
			return nil, errors.WithStack(err)
		}
		engine.metadata = append(engine.metadata, metadata)
	}
	engine.pool.put(bootstrap)
	engine.pool.warm()
	logger.InfoContext(ctx, "Loaded analyzers", "analyzers", engine.Names(), "duration", time.Since(start))
	return engine, nil
}

// Names returns the script analyzers' names in registration order.
func (e *Engine) Names() []string {
	names := make([]string, len(e.metadata))
	for i, metadata := range e.metadata {
		names[i] = metadata.Name
	}
	return names
}

// Describe documents every analyzer in registration order. Source holds the
// defining module, such as "project/nopanic.ts", and Enabled is unset:
// both depend on the project.
func (e *Engine) Describe() ([]docs.Analyzer, error) {
	described := make([]docs.Analyzer, 0, len(e.metadata))
	for _, metadata := range e.metadata {
		analyzer := docs.Analyzer{Name: metadata.Name, Doc: metadata.Doc, URL: metadata.URL, Source: metadata.Module}
		if metadata.Schema >= 0 {
			var defaults any
			if err := json.Unmarshal(metadata.Defaults, &defaults); err != nil {
				return nil, errors.Wrapf(err, "analyzer %s: decode config defaults", metadata.Name)
			}
			analyzer.Config = Some(docs.Config{Shape: e.program.Schemas[metadata.Schema], Defaults: defaults})
		}
		described = append(described, analyzer)
	}
	return described, nil
}

// Recorder returns the recorder of what analyzer runs read from the file
// system.
func (e *Engine) Recorder() *inputs.Recorder {
	return e.recorder
}

// Fingerprint identifies the compiled scripts and the settings analyzers built
// from file and mainModules would run with, so results can be cached.
func (e *Engine) Fingerprint(file config.File, mainModules []string) string {
	h := sha256.New()
	for _, name := range slices.Sorted(maps.Keys(e.program.Modules)) {
		h.Write(fmt.Appendf(nil, "module %q %q\n", name, e.program.Modules[name]))
	}
	// fmt prints maps in key order, so equal settings print the same.
	h.Write(fmt.Appendf(nil, "file %#v\nmain modules %q\n", file, mainModules))
	return hex.EncodeToString(h.Sum(nil))
}

// hostAnalyzers are the Go analyzers "tsk/passes" exports.
func hostAnalyzers() map[string]*analysis.Analyzer {
	return map[string]*analysis.Analyzer{"inspect": inspect.Analyzer, "buildssa": buildssa.Analyzer, "ctrlflow": ctrlflow.Analyzer}
}

// Analyzers builds analyzers configured by file, omitting disabled ones.
// Disabled analyzers still run when another requires them. Analyzers with
// module scope skip packages outside mainModules; with no main modules, as
// for GOPATH-style test data, nothing is skipped.
func (e *Engine) Analyzers(file config.File, mainModules []string) ([]*analysis.Analyzer, error) {
	if err := e.checkNames(file); err != nil {
		return nil, err
	}
	factTypes, err := e.factTypes()
	if err != nil {
		return nil, err
	}
	analyzers := map[string]*analysis.Analyzer{}
	environments := map[string]*vm.Environment{}
	timer := newLoadTimer(e.logger)
	for _, metadata := range e.metadata {
		resolved, err := e.resolveConfig(metadata, file.Tables[metadata.Name])
		if err != nil {
			return nil, err
		}
		environment := &vm.Environment{
			Config:        resolved,
			Facts:         factTypes[metadata.Name],
			Analyzers:     map[string]*analysis.Analyzer{},
			SkipGenerated: !file.LintGenerated,
			SkipTests:     metadata.SkipTests || file.NoTests || slices.Contains(file.SkipTests, metadata.Name),
			Recorder:      e.recorder,
		}
		environments[metadata.Name] = environment
		analyzers[metadata.Name] = e.analyzer(metadata, environment, mainModules, timer)
	}
	for _, metadata := range e.metadata {
		analyzer := analyzers[metadata.Name]
		for _, requirement := range metadata.Requires {
			required, ok := analyzers[requirement.Name]
			if requirement.Host {
				required, ok = hostAnalyzers()[requirement.Name]
			}
			if !ok {
				return nil, errors.Errorf("analyzer %s requires unknown analyzer %s", metadata.Name, requirement.Name)
			}
			analyzer.Requires = append(analyzer.Requires, required)
			environments[metadata.Name].Analyzers[requirement.Name] = required
		}
	}
	var enabled []*analysis.Analyzer
	for _, metadata := range e.metadata {
		if file.Enabled(metadata.Name) {
			enabled = append(enabled, analyzers[metadata.Name])
		}
	}
	if err := analysis.Validate(enabled); err != nil {
		return nil, errors.Wrap(err, "invalid analyzers")
	}
	return enabled, nil
}

func (e *Engine) checkNames(file config.File) error {
	known := e.Names()
	for _, name := range slices.Sorted(maps.Keys(file.Tables)) {
		if !slices.Contains(known, name) {
			return errors.Errorf("table %s names an unknown analyzer", name)
		}
	}
	for key, names := range map[string][]string{"disable": file.Disable, "enable": file.Enable, "skip-tests": file.SkipTests} {
		for _, name := range names {
			if !slices.Contains(known, name) {
				return errors.Errorf("%s names unknown analyzer %s", key, name)
			}
		}
	}
	return nil
}

// factTypes assigns each analyzer's facts a distinct pooled type.
func (e *Engine) factTypes() (map[string]map[string]reflect.Type, error) {
	count := 0
	for _, metadata := range e.metadata {
		count += len(metadata.Facts)
	}
	pooled, err := facts.Types(count)
	if err != nil {
		return nil, errors.WithStack(err)
	}
	assigned := map[string]map[string]reflect.Type{}
	for _, metadata := range e.metadata {
		assigned[metadata.Name] = map[string]reflect.Type{}
		for _, fact := range metadata.Facts {
			if _, duplicate := assigned[metadata.Name][fact]; duplicate {
				return nil, errors.Errorf("analyzer %s declares fact %s twice", metadata.Name, fact)
			}
			assigned[metadata.Name][fact] = pooled[0]
			pooled = pooled[1:]
		}
	}
	return assigned, nil
}

func (e *Engine) resolveConfig(metadata vm.Metadata, table map[string]any) (json.RawMessage, error) {
	var shape ts.Shape
	if metadata.Schema >= 0 {
		shape = e.program.Schemas[metadata.Schema]
	}
	var defaults any
	if err := json.Unmarshal(metadata.Defaults, &defaults); err != nil {
		return nil, errors.Wrapf(err, "analyzer %s: decode config defaults", metadata.Name)
	}
	resolved, err := config.Resolve(metadata.Name, shape, defaults, table)
	if err != nil {
		return nil, errors.WithStack(err)
	}
	data, err := json.Marshal(resolved)
	return data, errors.Wrapf(err, "analyzer %s: encode config", metadata.Name)
}

// loadTimer logs, once, how long the driver took to load packages: from when
// the analyzers were built to the first analyzer run. Drivers load every
// package before running any analyzer, and offer no hook of their own.
type loadTimer struct {
	logger *slog.Logger
	start  time.Time
	once   sync.Once
}

func newLoadTimer(logger *slog.Logger) *loadTimer {
	return &loadTimer{logger: logger, start: time.Now()}
}

// firstRun is called by every analyzer run; only the first one logs.
func (l *loadTimer) firstRun() {
	l.once.Do(func() {
		l.logger.Info("Loaded packages", "duration", time.Since(l.start))
	})
}

// inModules reports whether a package belongs to one of modules, or true when
// there are none to restrict to.
func inModules(pass *analysis.Pass, modules []string) bool {
	return len(modules) == 0 || (pass.Module != nil && slices.Contains(modules, pass.Module.Path))
}

func (e *Engine) analyzer(metadata vm.Metadata, environment *vm.Environment, mainModules []string, timer *loadTimer) *analysis.Analyzer {
	analyzer := &analysis.Analyzer{
		Name:             metadata.Name,
		Doc:              metadata.Doc,
		URL:              metadata.URL,
		RunDespiteErrors: metadata.RunDespiteErrors,
		ResultType:       reflect.TypeFor[json.RawMessage](),
	}
	for _, name := range slices.Sorted(maps.Keys(environment.Facts)) {
		analyzer.FactTypes = append(analyzer.FactTypes, facts.New(environment.Facts[name]))
	}
	analyzer.Run = func(pass *analysis.Pass) (any, error) {
		timer.firstRun()
		// Skipped before any script work: dependencies vastly outnumber the
		// packages being linted.
		if !metadata.AllPackages && !inModules(pass, mainModules) {
			return json.RawMessage("null"), nil
		}
		logger := e.logger.With("analyzer", metadata.Name, "package", pass.Pkg.Path())
		// The driver calls Run for every package at once, so a run only starts
		// once the pool, which bounds concurrency, lends it a runtime.
		queued := time.Now()
		runtime, err := e.pool.get()
		if err != nil {
			return nil, err
		}
		defer e.pool.put(runtime)
		start := time.Now()
		logger.Debug("Analyzer started", "wait", start.Sub(queued))
		// A copy, so the driver's pass keeps its own Report.
		filtered := *pass
		filtered.Report = nolint.Reporter(pass, metadata.Name)
		run := *environment
		run.Pass = &filtered
		result, err := runtime.Run(metadata.Name, run)
		if err != nil {
			logger.Debug("Analyzer failed", "duration", time.Since(start), "error", err)
			return nil, errors.Errorf("%s: %v", metadata.Name, err)
		}
		logger.Debug("Analyzer finished", "duration", time.Since(start))
		return result, nil
	}
	return analyzer
}
