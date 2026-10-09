package project_test

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alecthomas/assert/v2"
	. "github.com/alecthomas/types/optional"

	"github.com/alecthomas/tsk/internal/config"
	"github.com/alecthomas/tsk/internal/library"
	"github.com/alecthomas/tsk/internal/project"
)

func TestResolve(t *testing.T) {
	tests := []struct {
		name string
		// files are created under a temporary root; a trailing slash makes a directory.
		files    []string
		home     Option[string]
		cwd      string
		config   project.Config
		expected project.Config
	}{
		{
			name:     "FindsAboveNestedModule",
			files:    []string{"home/repo/.tsk/", "home/repo/mod/go.mod", "home/repo/mod/pkg/"},
			home:     Some("home"),
			cwd:      "home/repo/mod/pkg",
			expected: project.Config{Dir: "home/repo/.tsk", Config: "home/repo/.tsk/config.toml"},
		},
		{
			name:     "NearestWins",
			files:    []string{"home/repo/.tsk/", "home/repo/mod/.tsk/"},
			home:     Some("home"),
			cwd:      "home/repo/mod",
			expected: project.Config{Dir: "home/repo/mod/.tsk", Config: "home/repo/mod/.tsk/config.toml"},
		},
		{
			name:     "SearchesHome",
			files:    []string{"home/.tsk/", "home/repo/"},
			home:     Some("home"),
			cwd:      "home/repo",
			expected: project.Config{Dir: "home/.tsk", Config: "home/.tsk/config.toml"},
		},
		{
			name:     "StopsAtHome",
			files:    []string{".tsk/", "home/repo/go.mod", "home/repo/pkg/"},
			home:     Some("home"),
			cwd:      "home/repo/pkg",
			expected: project.Config{Dir: "home/repo/.tsk", Config: "home/repo/.tsk/config.toml"},
		},
		{
			name:     "OutsideHomeSearchesToRoot",
			files:    []string{"work/.tsk/", "work/repo/pkg/", "home/"},
			home:     Some("home"),
			cwd:      "work/repo/pkg",
			expected: project.Config{Dir: "work/.tsk", Config: "work/.tsk/config.toml"},
		},
		{
			name:     "IgnoresFilesNamedTsk",
			files:    []string{"home/repo/.tsk", "home/repo/mod/go.mod"},
			home:     Some("home"),
			cwd:      "home/repo/mod",
			expected: project.Config{Dir: "home/repo/mod/.tsk", Config: "home/repo/mod/.tsk/config.toml"},
		},
		{
			name:     "DefaultsToWorkingDirectory",
			files:    []string{"home/repo/"},
			home:     Some("home"),
			cwd:      "home/repo",
			expected: project.Config{Dir: "home/repo/.tsk", Config: "home/repo/.tsk/config.toml"},
		},
		{
			name:     "ConfigDefaultsInsideExplicitDir",
			files:    []string{"home/repo/.tsk/"},
			home:     Some("home"),
			cwd:      "home/repo",
			config:   project.Config{Dir: "home/scripts"},
			expected: project.Config{Dir: "home/scripts", Config: "home/scripts/config.toml"},
		},
		{
			name:     "ExplicitPathsWin",
			files:    []string{"home/repo/.tsk/"},
			home:     Some("home"),
			cwd:      "home/repo",
			config:   project.Config{Dir: "a", Config: "b.toml"},
			expected: project.Config{Dir: "a", Config: "b.toml"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			// Resolve symlinks so the working directory matches the paths built here.
			root, err := filepath.EvalSymlinks(t.TempDir())
			assert.NoError(t, err)
			for _, file := range test.files {
				path := filepath.Join(root, file)
				if strings.HasSuffix(file, "/") {
					assert.NoError(t, os.MkdirAll(path, 0o750))
					continue
				}
				assert.NoError(t, os.MkdirAll(filepath.Dir(path), 0o750))
				assert.NoError(t, os.WriteFile(path, nil, 0o600))
			}
			t.Chdir(filepath.Join(root, test.cwd))
			home := None[string]()
			if dir, ok := test.home.Get(); ok {
				home = Some(filepath.Join(root, dir))
			}
			resolved, err := absolute(root, test.config).Resolve(home)
			assert.NoError(t, err)
			assert.Equal(t, absolute(root, test.expected), resolved)
		})
	}
}

func absolute(root string, c project.Config) project.Config {
	if c.Dir != "" {
		c.Dir = filepath.Join(root, c.Dir)
	}
	if c.Config != "" {
		c.Config = filepath.Join(root, c.Config)
	}
	return c
}

// Lint applies a selection over the config file; test ignores the config
// file, so the selection picks from every analyzer.
func TestSelect(t *testing.T) {
	work := t.TempDir()
	t.Chdir(work)
	c := project.Config{Dir: filepath.Join(work, ".tsk"), Config: filepath.Join(work, ".tsk", "config.toml")}
	assert.NoError(t, os.MkdirAll(c.Dir, 0o750))
	assert.NoError(t, os.WriteFile(c.Config, []byte(`disable = ["one"]`), 0o600))
	for _, name := range []string{"one", "two", "three"} {
		assert.NoError(t, os.WriteFile(filepath.Join(c.Dir, name+".ts"), []byte(analyzerScript(name)), 0o600))
	}
	logger := slog.New(slog.DiscardHandler)
	p, err := project.Load(t.Context(), logger, c, library.NewCache(library.Config{Cache: t.TempDir()}, logger))
	assert.NoError(t, err)

	selected, err := p.Selected(config.Selection{Disable: []string{"two"}})
	assert.NoError(t, err)
	assert.Equal(t, []string{"one", "three"}, selected)
	_, err = p.Selected(config.Selection{Enable: []string{"four"}})
	assert.EqualError(t, err, "--enable names unknown analyzer four")

	assert.NoError(t, p.Select(config.LintSelection{Enable: []string{"one"}, Disable: []string{"three"}}))
	analyzers, err := p.Analyzers()
	assert.NoError(t, err)
	var names []string
	for _, analyzer := range analyzers {
		names = append(names, analyzer.Name)
	}
	assert.Equal(t, []string{"one", "two"}, names)
	assert.EqualError(t, p.Select(config.LintSelection{Disable: []string{"four"}}), "--disable names unknown analyzer four")
}
