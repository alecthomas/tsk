// Command tsk runs go/analysis linters written in TypeScript.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"strconv"

	"github.com/alecthomas/errors"
	"github.com/alecthomas/kong"
	"golang.org/x/term"
	"golang.org/x/tools/go/analysis/multichecker"

	"github.com/alecthomas/tsktsk/internal/docs"
	"github.com/alecthomas/tsktsk/internal/logger"
	"github.com/alecthomas/tsktsk/internal/project"
	"github.com/alecthomas/tsktsk/internal/scripttest"
	"github.com/alecthomas/tsktsk/linters"
)

type cli struct {
	project.Config `embed:""`
	Log            logger.Config `embed:""`

	Lint  lintCommand  `cmd:"" default:"withargs" help:"Lint packages with every enabled analyzer."`
	Test  testCommand  `cmd:"" help:"Run each analyzer against the testdata beside its scripts."`
	Check checkCommand `cmd:"" help:"Type-check scripts and validate the config file."`
	Init  initCommand  `cmd:"" help:"Write declarations and tsconfig.json for editors into the scripts directory."`
	// Named for the command because the embedded project.Config owns the
	// Config field name.
	ConfigCommand configCommand `cmd:"" name:"config" help:"Print a .tsk.toml documenting every analyzer and config option, set to their defaults."`
}

type lintCommand struct {
	Packages []string `arg:"" optional:"" default:"./..." help:"Package patterns to lint."`
	Fix      bool     `help:"Apply all suggested fixes."`
	Diff     bool     `help:"With --fix, print a unified diff instead of updating files."`
	JSON     bool     `help:"Emit JSON output."`
	Context  int      `short:"c" default:"-1" help:"Lines of context to show around each finding; -1 shows none."`
	Test     bool     `default:"true" negatable:"" help:"Analyze test files too."`
}

func (l lintCommand) Run(ctx context.Context, log *slog.Logger, c *project.Config) error {
	p, err := project.Load(ctx, log, linters.Scripts, *c)
	if err != nil {
		return errors.WithStack(err)
	}
	analyzers, err := p.Analyzers()
	if err != nil {
		return errors.WithStack(err)
	}
	// multichecker parses its options with the flag package and exits, so the
	// options Kong parsed are passed through in that form.
	os.Args = append([]string{os.Args[0]}, l.flagArgs()...) //nolint:reassign // multichecker only reads os.Args.
	log.InfoContext(ctx, "Loading packages", "patterns", l.Packages)
	multichecker.Main(analyzers...)
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

type testCommand struct{}

func (testCommand) Run(ctx context.Context, log *slog.Logger, c *project.Config) error {
	p, err := project.Load(ctx, log, linters.Scripts, *c)
	if err != nil {
		return errors.WithStack(err)
	}
	return errors.WithStack(scripttest.RunAll(p.Engine(), p.Dir(), os.Stdout))
}

type checkCommand struct{}

func (checkCommand) Run(ctx context.Context, log *slog.Logger, c *project.Config) error {
	p, err := project.Load(ctx, log, linters.Scripts, *c)
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

func (initCommand) Run(c *project.Config) error {
	return errors.WithStack(project.WriteEditorFiles(*c))
}

type configCommand struct {
	Analyzers []string `arg:"" optional:"" help:"Analyzers to describe. Defaults to all."`
}

func (d configCommand) Run(ctx context.Context, log *slog.Logger, c *project.Config) error {
	p, err := project.Load(ctx, log, linters.Scripts, *c)
	if err != nil {
		return errors.WithStack(err)
	}
	analyzers, err := p.Describe(d.Analyzers)
	if err != nil {
		return errors.WithStack(err)
	}
	// Colour only a terminal, so redirected output, such as a generated
	// .tsk.toml, stays plain. NO_COLOR follows the no-color.org convention.
	colour := term.IsTerminal(int(os.Stdout.Fd())) && os.Getenv("NO_COLOR") == ""
	return errors.WithStack(docs.TOML(os.Stdout, analyzers, colour))
}

func main() {
	ctx := context.Background()
	var config cli
	kctx := kong.Parse(&config, kong.Description("A go/analysis harness for linters written in TypeScript."),
		kong.BindTo(ctx, (*context.Context)(nil)))
	kctx.FatalIfErrorf(kctx.Run(&config.Config, logger.New(config.Log, os.Stderr)))
}
