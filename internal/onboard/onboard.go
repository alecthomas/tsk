// Package onboard sets a repository up to use tsk, with a config file and
// instructions for coding agents.
package onboard

import (
	"context"
	_ "embed"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/alecthomas/errors"
	. "github.com/alecthomas/types/optional"

	"github.com/alecthomas/tsk/internal/config"
	"github.com/alecthomas/tsk/internal/golangci"
	"github.com/alecthomas/tsk/internal/library"
	"github.com/alecthomas/tsk/internal/project"
)

//go:embed config.toml
var defaultConfig string

//go:embed agents.md
var agentsSection string

//go:embed SKILL.md
var skill string

// lintersImport is the library a new config imports.
const lintersImport = "github.com/alecthomas/tsk//linters"

// The markers delimit tsk's section of an agent instructions file, so running
// init again replaces the section instead of adding another.
const (
	beginMarker = "<!-- BEGIN tsk -->"
	endMarker   = "<!-- END tsk -->"
)

// Init sets up the repository holding the scripts directory. c must be
// resolved.
func Init(ctx context.Context, logger *slog.Logger, c project.Config, cache *library.Cache, out io.Writer) error {
	root := filepath.Dir(c.Dir)
	if err := writeConfig(ctx, logger, c, cache, root, out); err != nil {
		return err
	}
	if err := ignoreEditorFiles(root, c.Dir, out); err != nil {
		return err
	}
	return writeInstructions(root, out)
}

// writeConfig writes and pins the config file, converting any golangci-lint
// config. A failure removes it, so that running init again starts afresh.
func writeConfig(ctx context.Context, logger *slog.Logger, c project.Config, cache *library.Cache, root string, out io.Writer) (err error) {
	_, statErr := os.Stat(c.Config)
	if statErr == nil {
		fmt.Fprintf(out, "keep %s\n", relative(root, c.Config)) //nolint:errcheck // Output is best effort.
		return nil
	}
	if !errors.Is(statErr, os.ErrNotExist) {
		return errors.Wrap(statErr, "check config")
	}
	defer func() {
		if err != nil {
			// Cleanup is best effort; the failure that caused it is what matters.
			_ = os.Remove(c.Config)     //nolint:errcheck // See above.
			_ = os.Remove(c.LockFile()) //nolint:errcheck // Either file may not exist yet.
		}
	}()
	// Pinning writes a config holding only the imports, which the settings
	// then fill in around.
	linters, err := library.ParseImport(lintersImport)
	if err != nil {
		return errors.WithStack(err)
	}
	// Get lists every analyzer a new library adds, which for a new config is
	// all of them, so only the pinned imports are reported.
	if err := project.Get(ctx, logger, c, cache, []library.Import{linters}, io.Discard); err != nil {
		return errors.WithStack(err)
	}
	file, err := config.Load(c.Config)
	if err != nil {
		return errors.WithStack(err)
	}
	for _, imported := range file.Imports {
		fmt.Fprintf(out, "import %s\n", imported) //nolint:errcheck // Output is best effort.
	}
	if source, ok := golangci.Find(root); ok {
		if err := convertGolangci(ctx, logger, c, cache, root, source, out); err != nil {
			return err
		}
		fmt.Fprintf(out, "write %s from %s\n", relative(root, c.Config), relative(root, source)) //nolint:errcheck // Output is best effort.
		return nil
	}
	text, err := config.SetImports([]byte(defaultConfig), file.Imports)
	if err != nil {
		return errors.Wrap(err, "default config")
	}
	if err := os.WriteFile(c.Config, text, 0o600); err != nil {
		return errors.Wrap(err, "write config")
	}
	fmt.Fprintf(out, "write %s\n", relative(root, c.Config)) //nolint:errcheck // Output is best effort.
	return nil
}

// convertGolangci replaces the config file's settings with those converted
// from the golangci-lint config at source, keeping its imports.
func convertGolangci(ctx context.Context, logger *slog.Logger, c project.Config, cache *library.Cache, root, source string, out io.Writer) error {
	// Converting checks options against the imported analyzers, so they load first.
	p, err := project.Load(ctx, logger, c, cache)
	if err != nil {
		return errors.WithStack(err)
	}
	analyzers, err := p.Describe(nil)
	if err != nil {
		return errors.WithStack(err)
	}
	return errors.WithStack(golangci.Import(logger, out, golangci.Config{File: source}, root, c.Config, analyzers))
}

// ignoreEditorFiles adds the files tsk editor writes to the scripts
// directory's .gitignore, as they hold paths specific to one machine.
func ignoreEditorFiles(root, dir string, out io.Writer) error {
	path := filepath.Join(dir, ".gitignore")
	text, err := readOptional(path)
	if err != nil {
		return err
	}
	updated := text
	for _, pattern := range []string{"/types/", "/tsconfig.json"} {
		if slices.Contains(strings.Split(updated, "\n"), pattern) {
			continue
		}
		if updated != "" && !strings.HasSuffix(updated, "\n") {
			updated += "\n"
		}
		updated += pattern + "\n"
	}
	return update(root, path, text, updated, out)
}

// writeInstructions sets tsk's section of the agent instructions and writes the
// tsk skill, for Claude Code if root has a CLAUDE.md, and for other agents if
// it has an AGENTS.md or no CLAUDE.md.
func writeInstructions(root string, out io.Writer) error {
	agents := filepath.Join(root, "AGENTS.md")
	claude := filepath.Join(root, "CLAUDE.md")
	agentsInfo, err := statOptional(agents)
	if err != nil {
		return err
	}
	claudeInfo, err := statOptional(claude)
	if err != nil {
		return err
	}
	// Claude Code ignores AGENTS.md when there is a CLAUDE.md, and other agents
	// ignore CLAUDE.md, so each needs its own section and skill.
	if agentsInfo.Ok() || !claudeInfo.Ok() {
		if err := writeSection(root, agents, out); err != nil {
			return err
		}
		if err := writeSkill(root, filepath.Join(root, ".agents"), out); err != nil {
			return err
		}
	}
	claudeFile, ok := claudeInfo.Get()
	if !ok {
		return nil
	}
	// A CLAUDE.md that links to AGENTS.md got its section through AGENTS.md.
	if agentsFile, ok := agentsInfo.Get(); !ok || !os.SameFile(agentsFile, claudeFile) {
		if err := writeSection(root, claude, out); err != nil {
			return err
		}
	}
	return writeSkill(root, filepath.Join(root, ".claude"), out)
}

// writeSection sets tsk's section of the agent instructions file at path.
func writeSection(root, path string, out io.Writer) error {
	text, err := readOptional(path)
	if err != nil {
		return err
	}
	updated, err := setSection(text, agentsSection)
	if err != nil {
		return errors.Wrapf(err, "%s", path)
	}
	return update(root, path, text, updated, out)
}

// writeSkill writes the tsk skill into an agent's config directory.
func writeSkill(root, agentDir string, out io.Writer) error {
	path := filepath.Join(agentDir, "skills", "tsk", "SKILL.md")
	existing, err := readOptional(path)
	if err != nil {
		return err
	}
	return update(root, path, existing, skill, out)
}

// statOptional returns a file's info, following links, or None if it does not
// exist.
func statOptional(path string) (Option[os.FileInfo], error) {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return None[os.FileInfo](), nil
	}
	if err != nil {
		return None[os.FileInfo](), errors.Wrapf(err, "stat %q", path)
	}
	return Some(info), nil
}

// readOptional returns a file's text, or "" if it does not exist.
func readOptional(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", errors.Wrapf(err, "read %q", path)
	}
	return string(data), nil
}

// update writes text to path unless it holds that already, so running init
// again leaves files untouched. It reports what it did to out.
func update(root, path, existing, text string, out io.Writer) error {
	if existing == text {
		fmt.Fprintf(out, "keep %s\n", relative(root, path)) //nolint:errcheck // Output is best effort.
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return errors.Wrapf(err, "create directory for %q", path)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil { //nolint:gosec // The files are committed, so not private.
		return errors.Wrapf(err, "write %q", path)
	}
	fmt.Fprintf(out, "write %s\n", relative(root, path)) //nolint:errcheck // Output is best effort.
	return nil
}

// setSection returns text with the section between the markers replaced, or
// appended if text has none.
func setSection(text, section string) (string, error) {
	block := beginMarker + "\n" + section + endMarker + "\n"
	begin := strings.Index(text, beginMarker)
	if begin < 0 {
		if strings.TrimSpace(text) == "" {
			return block, nil
		}
		return strings.TrimRight(text, "\n") + "\n\n" + block, nil
	}
	end := strings.Index(text[begin:], endMarker)
	if end < 0 {
		return "", errors.Errorf("%s has no matching %s", beginMarker, endMarker)
	}
	rest := strings.TrimPrefix(text[begin+end+len(endMarker):], "\n")
	return text[:begin] + block + rest, nil
}

// relative returns path relative to root, or path itself if it is outside root.
func relative(root, path string) string {
	if rel, err := filepath.Rel(root, path); err == nil && !strings.HasPrefix(rel, "..") {
		return rel
	}
	return path
}
