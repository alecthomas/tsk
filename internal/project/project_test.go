package project_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alecthomas/assert/v2"
	. "github.com/alecthomas/types/optional"

	"github.com/alecthomas/tsktsk/internal/project"
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
