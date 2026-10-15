// Command tsk runs go/analysis linters written in TypeScript.
package main

import (
	"context"
	"fmt"
	"go/build"
	"log/slog"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"

	"github.com/alecthomas/errors"
	"github.com/alecthomas/kong"
	. "github.com/alecthomas/types/optional"
	"golang.org/x/term"
	"golang.org/x/tools/go/analysis/multichecker"

	"github.com/alecthomas/tsk/internal/config"
	"github.com/alecthomas/tsk/internal/docs"
	"github.com/alecthomas/tsk/internal/golangci"
	"github.com/alecthomas/tsk/internal/library"
	"github.com/alecthomas/tsk/internal/lint"
	"github.com/alecthomas/tsk/internal/logger"
	"github.com/alecthomas/tsk/internal/project"
	"github.com/alecthomas/tsk/internal/scripttest"
)

type cli struct {
	project.Config `embed:""`
	Library        library.Config `embed:""`
	Log            logger.Config  `embed:""`

	Lint  lintCommand  `cmd:"" default:"withargs" help:"Lint packages with every enabled analyzer."`
	Test  testCommand  `cmd:"" help:"Run each analyzer against the testdata beside its scripts."`
	Check checkCommand `cmd:"" help:"Type-check scripts and validate the config file."`
	Init  initCommand  `cmd:"" help:"Write declarations and tsconfig.json for editors into the scripts directory."`
	// Named for the command because the embedded project.Config owns the
	// Config field name.
	ConfigCommand configCommand `cmd:"" name:"config" help:"Print a documented config file, or import one from golangci-lint."`
	List          listCommand   `cmd:"" help:"List every analyzer, whether it is enabled, and where it is defined."`
	Get           getCommand    `cmd:"" help:"Add or update linter libraries, and pin every import in the lock file."`
	Sync          syncCommand   `cmd:"" help:"Download every locked linter library missing from the cache."`
}

type lintCommand struct {
	lint.Config          `embed:""`
	config.LintSelection `embed:""`
	Fix                  bool `help:"Apply all suggested fixes."`
	Diff                 bool `help:"With --fix, print a unified diff instead of updating files."`
}

func (l lintCommand) Run(ctx context.Context, log *slog.Logger, c *project.Config, cache *library.Cache, results Option[*lint.Cache]) error {
	dir, err := os.Getwd()
	if err != nil {
		return errors.Wrap(err, "find working directory")
	}
	// Looking up cached findings starts first, to overlap loading the
	// project. JSON output and fixes do not use the cache.
	lookup := None[*lint.Lookup]()
	if store, ok := results.Get(); ok && !l.JSON && !l.Fix {
		started := lint.StartLookup(ctx, store, l.Config, dir)
		defer started.Close()
		lookup = Some(started)
	}
	p, err := project.Load(ctx, log, *c, cache)
	if err != nil {
		return errors.WithStack(err)
	}
	if err := p.Select(l.LintSelection); err != nil {
		return errors.WithStack(err)
	}
	analyzers, err := p.Analyzers()
	if err != nil {
		return errors.WithStack(err)
	}
	log.InfoContext(ctx, "Loading packages", "patterns", l.Packages)
	if l.Fix {
		// Applying fixes is internal to multichecker. It parses its options with
		// the flag package and exits, so the parsed options pass through as flags.
		os.Args = append([]string{os.Args[0]}, l.flagArgs()...) //nolint:reassign // multichecker only reads os.Args.
		multichecker.Main(analyzers...)
	}
	analysis := lint.Analysis{Analyzers: analyzers, Recorder: p.Engine().Recorder(), Fingerprint: p.Fingerprint()}
	code, err := lint.Run(ctx, log, analysis, lookup, l.Config, dir, os.Stdout, os.Stderr)
	if err != nil {
		return errors.WithStack(err)
	}
	os.Exit(code)
	return nil
}

func (l lintCommand) flagArgs() []string {
	args := []string{
		"-fix=" + strconv.FormatBool(l.Fix),
		"-diff=" + strconv.FormatBool(l.Diff),
		"-json=" + strconv.FormatBool(l.JSON),
		"-c=" + strconv.Itoa(l.Context),
		"-test=" + strconv.FormatBool(l.Test),
		"--",
	}
	return append(args, l.Packages...)
}

type testCommand struct {
	config.TestSelection `embed:""`
	scripttest.Config    `embed:""`
}

func (t testCommand) Run(ctx context.Context, log *slog.Logger, c *project.Config, cache *library.Cache, store *scripttest.Store) error {
	p, err := project.Load(ctx, log, *c, cache)
	if err != nil {
		return errors.WithStack(err)
	}
	analyzers, err := p.Selected(t.TestSelection)
	if err != nil {
		return errors.WithStack(err)
	}
	return errors.WithStack(scripttest.RunAll(p.Engine(), store, analyzers, p.Dir(), os.Stdout, t.Config, isolateCase(ctx)))
}

// isolateCase reruns this command for one case in a new process, whose
// environment selects the case's target platform.
func isolateCase(ctx context.Context) scripttest.Isolate {
	return func(name string, env []string) ([]byte, error) {
		executable, err := os.Executable()
		if err != nil {
			return nil, errors.Wrap(err, "find tsk")
		}
		args := append(slices.Clone(os.Args[1:]), "--json", "--case="+name)
		command := exec.CommandContext(ctx, executable, args...)
		command.Env = append(os.Environ(), env...)
		out, err := command.Output()
		return out, errors.Wrapf(err, "run case %s", name)
	}
}

type checkCommand struct{}

func (checkCommand) Run(ctx context.Context, log *slog.Logger, c *project.Config, cache *library.Cache) error {
	p, err := project.Load(ctx, log, *c, cache)
	if err != nil {
		return errors.WithStack(err)
	}
	analyzers, err := p.Analyzers()
	if err != nil {
		return errors.WithStack(err)
	}
	fmt.Printf("ok: %d analyzers enabled of %d\n", len(analyzers), len(p.Names())) //nolint:forbidigo // The summary is the command's output.
	return nil
}

type initCommand struct{}

func (initCommand) Run(ctx context.Context, c *project.Config, cache *library.Cache) error {
	return errors.WithStack(project.WriteEditorFiles(ctx, *c, cache))
}

type configCommand struct {
	Show   configShowCommand   `cmd:"" default:"withargs" help:"Print a .tsk/config.toml documenting every analyzer and config option, set to their defaults."`
	Import configImportCommand `cmd:"" help:"Write the config file from a golangci-lint v2 config, keeping its imports and replace."`
}

type configShowCommand struct {
	Analyzers []string `arg:"" optional:"" help:"Analyzers to describe. Defaults to all."`
}

type configImportCommand struct {
	golangci.Config `embed:""`
}

func (i configImportCommand) Run(ctx context.Context, log *slog.Logger, c *project.Config, cache *library.Cache) error {
	dir, err := os.Getwd()
	if err != nil {
		return errors.Wrap(err, "find working directory")
	}
	p, err := project.Load(ctx, log, *c, cache)
	if err != nil {
		return errors.WithStack(err)
	}
	analyzers, err := p.Describe(nil)
	if err != nil {
		return errors.WithStack(err)
	}
	return errors.WithStack(golangci.Import(log, os.Stderr, i.Config, dir, c.Config, analyzers))
}

func (d configShowCommand) Run(ctx context.Context, log *slog.Logger, c *project.Config, cache *library.Cache) error {
	p, err := project.Load(ctx, log, *c, cache)
	if err != nil {
		return errors.WithStack(err)
	}
	analyzers, err := p.Describe(d.Analyzers)
	if err != nil {
		return errors.WithStack(err)
	}
	// Colour only a terminal, so redirected output, such as a generated
	// .tsk/config.toml, stays plain. NO_COLOR follows the no-color.org convention.
	colour := term.IsTerminal(int(os.Stdout.Fd())) && os.Getenv("NO_COLOR") == ""
	// Named analyzers get only their own tables, without the global settings.
	options := docs.Options{Settings: len(d.Analyzers) == 0, Colour: colour}
	return errors.WithStack(docs.TOML(os.Stdout, analyzers, options))
}

type listCommand struct {
	JSON bool `help:"Print a JSON array of analyzers, with their full documentation."`
}

func (l listCommand) Run(ctx context.Context, log *slog.Logger, c *project.Config, cache *library.Cache) error {
	p, err := project.Load(ctx, log, *c, cache)
	if err != nil {
		return errors.WithStack(err)
	}
	analyzers, err := p.Describe(nil)
	if err != nil {
		return errors.WithStack(err)
	}
	if l.JSON {
		return errors.WithStack(docs.ListJSON(os.Stdout, analyzers))
	}
	return errors.WithStack(docs.List(os.Stdout, analyzers))
}

type getCommand struct {
	Libraries []library.Import `arg:"" optional:"" help:"Libraries to add or update, as repository[@version][//dir]. Without a version, the highest semver tag or the default branch. Without libraries, update every import to its latest version, except one whose version was edited by hand."`
}

func (g getCommand) Run(ctx context.Context, log *slog.Logger, c *project.Config, cache *library.Cache) error {
	return errors.WithStack(project.Get(ctx, log, *c, cache, g.Libraries, os.Stdout))
}

type syncCommand struct{}

func (syncCommand) Run(ctx context.Context, c *project.Config, cache *library.Cache) error {
	return errors.WithStack(project.Sync(ctx, *c, cache))
}

func main() {
	ctx := context.Background()
	var config cli
	kctx := kong.Parse(&config, kong.Description("A go/analysis harness for linters written in TypeScript."),
		kong.BindTo(ctx, (*context.Context)(nil)))
	home := None[string]()
	if dir, err := os.UserHomeDir(); err == nil {
		home = Some(dir)
	}
	resolved, err := config.Config.Resolve(home)
	kctx.FatalIfErrorf(err)
	userCache := None[string]()
	if dir, err := os.UserCacheDir(); err == nil {
		userCache = Some(dir)
	}
	cacheConfig, err := config.Library.Resolve(userCache)
	kctx.FatalIfErrorf(err)
	log := logger.New(config.Log, os.Stderr)
	// Scripts find the standard library and the target platform through
	// go/build, whose GOROOT is the one tsk was built with, or empty with
	// -trimpath. Use the user's toolchain, which also follows GOTOOLCHAIN, and
	// its target, which also follows the go env file as packages are loaded.
	if out, err := exec.CommandContext(ctx, "go", "env", "GOROOT", "GOOS", "GOARCH").Output(); err == nil {
		if lines := strings.Split(strings.TrimSpace(string(out)), "\n"); len(lines) == 3 {
			build.Default.GOROOT, build.Default.GOOS, build.Default.GOARCH = lines[0], lines[1], lines[2]
		}
	} else {
		log.Debug("Could not read the Go environment", "error", err)
	}
	results := None[*lint.Cache]()
	if dir, ok := cacheConfig.Results().Get(); ok {
		results = Some(lint.NewCache(dir))
	}
	// The store follows the toolchain found above, so it is created after.
	store := scripttest.NewStore(cacheConfig.Testdata())
	kctx.FatalIfErrorf(kctx.Run(&resolved, log, library.NewCache(cacheConfig, log), results, store))
}
