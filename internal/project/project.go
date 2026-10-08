// Package project locates and loads a project's linter scripts and config.
package project

import (
	"bytes"
	"context"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	"github.com/alecthomas/errors"
	. "github.com/alecthomas/types/optional"
	"golang.org/x/tools/go/analysis"

	"github.com/alecthomas/tsk/internal/compile"
	"github.com/alecthomas/tsk/internal/config"
	"github.com/alecthomas/tsk/internal/docs"
	"github.com/alecthomas/tsk/internal/engine"
	"github.com/alecthomas/tsk/internal/library"
)

// ScriptsDir is the scripts directory's name.
const ScriptsDir = ".tsk"

// Config locates the scripts directory and config file.
type Config struct {
	Dir    string `help:"Scripts directory. Defaults to the nearest .tsk above the working directory, up to the home directory." type:"path"`
	Config string `help:"Config file. Defaults to config.toml in the scripts directory." type:"path"`
}

// Resolve finds the nearest .tsk searching up from the working directory to home,
// else defaults to beside the nearest go.mod or the working directory.
func (c Config) Resolve(home Option[string]) (Config, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return Config{}, errors.Wrap(err, "find working directory")
	}
	if c.Dir == "" {
		dir, found := findUp(cwd, home, ScriptsDir, fs.FileInfo.IsDir)
		if !found {
			root := cwd
			if modFile, hasModule := findUp(cwd, home, "go.mod", isRegular); hasModule {
				root = filepath.Dir(modFile)
			}
			dir = filepath.Join(root, ScriptsDir)
		}
		c.Dir = dir
	}
	if c.Config == "" {
		c.Config = filepath.Join(c.Dir, config.FileName)
	}
	return c, nil
}

// findUp returns the path of the first entry called name that match accepts,
// in start or its ancestors, stopping after stop or at the filesystem root.
func findUp(start string, stop Option[string], name string, match func(info fs.FileInfo) bool) (path string, found bool) {
	for dir := start; ; dir = filepath.Dir(dir) {
		candidate := filepath.Join(dir, name)
		if info, err := os.Stat(candidate); err == nil && match(info) {
			return candidate, true
		}
		if stopDir, ok := stop.Get(); (ok && dir == filepath.Clean(stopDir)) || filepath.Dir(dir) == dir {
			return "", false
		}
	}
}

func isRegular(info fs.FileInfo) bool {
	return info.Mode().IsRegular()
}

// LockFile returns the lock file's path, beside the config file.
func (c Config) LockFile() string {
	return filepath.Join(filepath.Dir(c.Config), library.LockFileName)
}

// Project is a loaded set of scripts with its config file.
type Project struct {
	config    Config
	engine    *engine.Engine
	file      config.File
	libraries []library.Locked
	// mainModules are the modules being linted, as go list -m reports them,
	// so a workspace has several.
	mainModules []string
}

// Load compiles the compiled-in scripts, then the config's libraries, then the
// scripts directory if present, each overriding analyzers of the same name in
// the ones before. c must be resolved. Script console output goes to logger.
func Load(ctx context.Context, logger *slog.Logger, builtin fs.FS, c Config, cache *library.Cache) (*Project, error) {
	file, err := config.Load(c.Config)
	if err != nil {
		return nil, errors.WithStack(err)
	}
	libraries, err := snapshots(ctx, c, file, cache)
	if err != nil {
		return nil, err
	}
	sources := []compile.Source{{Name: "builtin", FS: builtin}}
	locked := make([]library.Locked, 0, len(libraries))
	for _, snapshot := range libraries {
		sources = append(sources, compile.Source{Name: snapshot.locked.Path(), FS: os.DirFS(snapshot.dir), Library: true})
		locked = append(locked, snapshot.locked)
	}
	if info, err := os.Stat(c.Dir); err == nil && info.IsDir() {
		sources = append(sources, compile.Source{Name: "project", FS: os.DirFS(c.Dir)})
	}
	e, err := engine.Load(ctx, logger, sources)
	if err != nil {
		return nil, errors.WithStack(err)
	}
	mainModules, err := listMainModules(ctx)
	if err != nil {
		return nil, err
	}
	return &Project{config: c, engine: e, file: file, libraries: locked, mainModules: mainModules}, nil
}

// Sync downloads every library the lock file pins that is missing from the
// cache. c must be resolved.
func Sync(ctx context.Context, c Config, cache *library.Cache) error {
	file, err := config.Load(c.Config)
	if err != nil {
		return errors.WithStack(err)
	}
	_, err = snapshots(ctx, c, file, cache)
	return err
}

// snapshot is a locked library and the cache directory holding it.
type snapshot struct {
	locked library.Locked
	dir    string
}

// snapshots checks that the lock file pins exactly the config's imports, and
// returns each in import order, downloading any missing from the cache.
func snapshots(ctx context.Context, c Config, file config.File, cache *library.Cache) ([]snapshot, error) {
	lock, err := library.LoadLock(c.LockFile())
	if err != nil {
		return nil, errors.WithStack(err)
	}
	if err := lock.Check(file.Imports); err != nil {
		return nil, errors.Wrapf(err, "%s does not match the imports in %s; run tsk get", c.LockFile(), c.Config)
	}
	found := make([]snapshot, 0, len(file.Imports))
	for _, imported := range file.Imports {
		locked, _ := lock.Find(imported.Path())
		dir, err := cache.Snapshot(ctx, locked)
		if err != nil {
			return nil, errors.WithStack(err)
		}
		found = append(found, snapshot{locked: locked, dir: dir})
	}
	return found, nil
}

// listMainModules asks the go command for the main modules of the working
// directory, as go/packages will load them. Outside a module there are none.
func listMainModules(ctx context.Context) ([]string, error) {
	var stderr bytes.Buffer
	command := exec.CommandContext(ctx, "go", "list", "-m", "-f", "{{.Path}}")
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		if strings.Contains(stderr.String(), "not using modules") || strings.Contains(stderr.String(), "go.mod file not found") {
			return nil, nil
		}
		return nil, errors.Errorf("list main modules: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	return strings.Fields(string(output)), nil
}

// Analyzers returns the enabled analyzers configured by the config file.
func (p *Project) Analyzers() ([]*analysis.Analyzer, error) {
	configured, err := p.engine.Analyzers(p.file, p.mainModules)
	return configured, errors.Wrapf(err, "%s", p.config.Config)
}

// Names returns every loaded analyzer's name, enabled or not.
func (p *Project) Names() []string {
	return p.engine.Names()
}

// Engine returns the loaded scripts.
func (p *Project) Engine() *engine.Engine {
	return p.engine
}

// Dir returns the resolved scripts directory.
func (p *Project) Dir() string {
	return p.config.Dir
}

// Describe documents the named analyzers, or every analyzer when names is
// empty, with whether the config enables each and where each is defined.
func (p *Project) Describe(names []string) ([]docs.Analyzer, error) {
	described, err := p.engine.Describe()
	if err != nil {
		return nil, errors.WithStack(err)
	}
	known := p.engine.Names()
	for _, name := range names {
		if !slices.Contains(known, name) {
			return nil, errors.Errorf("unknown analyzer %s", name)
		}
	}
	selected := make([]docs.Analyzer, 0, len(described))
	for _, analyzer := range described {
		if len(names) > 0 && !slices.Contains(names, analyzer.Name) {
			continue
		}
		analyzer.Enabled = p.file.Enabled(analyzer.Name)
		analyzer.Source = p.source(analyzer.Source)
		selected = append(selected, analyzer)
	}
	return selected, nil
}

// source names where a module is defined: "builtin" for compiled-in scripts,
// a library's path and commit, or the script's path, relative to the working
// directory if it is within it.
func (p *Project) source(module string) string {
	for _, locked := range p.libraries {
		if strings.HasPrefix(module, locked.Path()+"/") {
			return locked.Path() + "@" + locked.Short()
		}
	}
	script, isProject := strings.CutPrefix(module, "project/")
	if !isProject {
		return "builtin"
	}
	path := filepath.Join(p.config.Dir, script)
	if cwd, err := os.Getwd(); err == nil {
		if relative, err := filepath.Rel(cwd, path); err == nil && !strings.HasPrefix(relative, "..") {
			return relative
		}
	}
	return path
}
