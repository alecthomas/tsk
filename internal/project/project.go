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
	"golang.org/x/tools/go/analysis"

	"github.com/alecthomas/tsktsk/internal/compile"
	"github.com/alecthomas/tsktsk/internal/config"
	"github.com/alecthomas/tsktsk/internal/docs"
	"github.com/alecthomas/tsktsk/internal/engine"
)

// ScriptsDir is the scripts directory's name, found beside the nearest go.mod.
const ScriptsDir = ".tsk"

// Config locates the scripts directory and config file.
type Config struct {
	Dir    string `help:"Scripts directory. Defaults to .tsk beside the nearest go.mod." type:"path"`
	Config string `help:"Config file. Defaults to .tsk.toml beside the scripts directory." type:"path"`
}

// Resolve fills in default locations from the nearest go.mod above the
// working directory, or the working directory itself.
func (c Config) Resolve() (Config, error) {
	if c.Dir == "" {
		root, err := moduleRoot()
		if err != nil {
			return Config{}, err
		}
		c.Dir = filepath.Join(root, ScriptsDir)
	}
	if c.Config == "" {
		c.Config = filepath.Join(filepath.Dir(c.Dir), config.FileName)
	}
	return c, nil
}

func moduleRoot() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", errors.Wrap(err, "find working directory")
	}
	for dir := cwd; ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		if filepath.Dir(dir) == dir {
			return cwd, nil
		}
	}
}

// Project is a loaded set of scripts with its config file.
type Project struct {
	config Config
	engine *engine.Engine
	file   config.File
	// mainModules are the modules being linted, as go list -m reports them,
	// so a workspace has several.
	mainModules []string
}

// Load compiles the compiled-in scripts and, if present, the scripts
// directory, which overrides them, and reads the config file. Script console
// output goes to logger.
func Load(ctx context.Context, logger *slog.Logger, builtin fs.FS, c Config) (*Project, error) {
	c, err := c.Resolve()
	if err != nil {
		return nil, err
	}
	sources := []compile.Source{{Name: "builtin", FS: builtin}}
	if info, err := os.Stat(c.Dir); err == nil && info.IsDir() {
		sources = append(sources, compile.Source{Name: "project", FS: os.DirFS(c.Dir)})
	}
	e, err := engine.Load(ctx, logger, sources)
	if err != nil {
		return nil, errors.WithStack(err)
	}
	file, err := config.Load(c.Config)
	if err != nil {
		return nil, errors.WithStack(err)
	}
	mainModules, err := listMainModules(ctx)
	if err != nil {
		return nil, err
	}
	return &Project{config: c, engine: e, file: file, mainModules: mainModules}, nil
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
// or the script's path, relative to the working directory if it is within it.
func (p *Project) source(module string) string {
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
