package project_test

import (
	"bytes"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/alecthomas/assert/v2"

	"github.com/alecthomas/tsk/internal/library"
	"github.com/alecthomas/tsk/internal/project"
)

// remotes serves repositories from a directory: git rewrites https:// URLs
// to it, as a user's insteadOf setting would. Like hosted servers, it
// supports partial clones.
func remotes(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for key, value := range map[string]string{
		"GIT_CONFIG_NOSYSTEM": "1",
		"GIT_CONFIG_GLOBAL":   os.DevNull,
		"GIT_CONFIG_COUNT":    "2",
		"GIT_CONFIG_KEY_0":    "url.file://" + filepath.ToSlash(root) + "/.insteadOf",
		"GIT_CONFIG_VALUE_0":  "https://",
		"GIT_CONFIG_KEY_1":    "uploadpack.allowFilter",
		"GIT_CONFIG_VALUE_1":  "true",
		"GIT_AUTHOR_NAME":     "test",
		"GIT_AUTHOR_EMAIL":    "test@example.com",
		"GIT_COMMITTER_NAME":  "test",
		"GIT_COMMITTER_EMAIL": "test@example.com",
	} {
		t.Setenv(key, value)
	}
	return root
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	command := exec.CommandContext(t.Context(), "git", args...)
	command.Dir = dir
	output, err := command.CombinedOutput()
	assert.NoError(t, err, "git %s: %s", strings.Join(args, " "), output)
	return strings.TrimSpace(string(output))
}

// release commits files to a repository, creating it if needed, tags the
// commit, and returns it abbreviated as tsk shows it.
func release(t *testing.T, dir, tag string, files map[string]string) string {
	t.Helper()
	if _, err := os.Stat(dir); err != nil {
		assert.NoError(t, os.MkdirAll(dir, 0o750))
		git(t, dir, "init", "--quiet", "--initial-branch=main")
	}
	for name, content := range files {
		assert.NoError(t, os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o750))
		assert.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600))
	}
	git(t, dir, "add", "--all")
	git(t, dir, "commit", "--quiet", "--message="+tag)
	git(t, dir, "tag", tag)
	return git(t, dir, "rev-parse", "HEAD")[:12]
}

func analyzerScript(name string) string {
	return `import { defineAnalyzer } from "tsk";
export default defineAnalyzer({ name: "` + name + `", doc: "` + name + ` linter", run() {} });
`
}

func TestGet(t *testing.T) {
	root := remotes(t)
	repository := filepath.Join(root, "github.com", "acme", "linters")
	first := release(t, repository, "v1.0.0", map[string]string{"lib/one.ts": analyzerScript("one"), "README.md": "linters"})
	second := release(t, repository, "v1.1.0", map[string]string{"lib/two.ts": analyzerScript("two")})
	work := t.TempDir()
	t.Chdir(work)
	c := project.Config{Dir: filepath.Join(work, ".tsk"), Config: filepath.Join(work, ".tsk", "config.toml")}
	assert.NoError(t, os.MkdirAll(c.Dir, 0o750))
	assert.NoError(t, os.WriteFile(c.Config, []byte("# Kept.\ndisable = [\"two\"]\n"), 0o600))
	logger := slog.New(slog.DiscardHandler)
	cache := library.NewCache(library.Config{Cache: t.TempDir()}, logger)
	get := func(requests ...string) string {
		t.Helper()
		imports := make([]library.Import, 0, len(requests))
		for _, request := range requests {
			imported, err := library.ParseImport(request)
			assert.NoError(t, err)
			imports = append(imports, imported)
		}
		var out bytes.Buffer
		assert.NoError(t, project.Get(t.Context(), logger, c, cache, imports, &out))
		return out.String()
	}
	readConfig := func() string {
		t.Helper()
		data, err := os.ReadFile(c.Config)
		assert.NoError(t, err)
		return string(data)
	}

	assert.Equal(t, "add github.com/acme/linters@v1.0.0//lib ("+first+")\n  + one\n", get("github.com/acme/linters@v1.0.0//lib"))
	assert.Equal(t, "imports = [\n  \"github.com/acme/linters@v1.0.0//lib\",\n]\n\n# Kept.\ndisable = [\"two\"]\n", readConfig())
	p, err := project.Load(t.Context(), logger, fstest.MapFS{}, c, cache)
	assert.NoError(t, err)
	described, err := p.Describe(nil)
	assert.NoError(t, err)
	assert.Equal(t, 1, len(described))
	assert.Equal(t, "github.com/acme/linters/lib@"+first, described[0].Source)

	assert.Equal(t, "", get(), "an unchanged lock reports nothing")
	assert.Equal(t, "update github.com/acme/linters@v1.0.0//lib ("+first+") => v1.1.0 ("+second+")\n  + two\n", get("github.com/acme/linters//lib"))
	assert.Contains(t, readConfig(), `"github.com/acme/linters@v1.1.0//lib"`)

	// A version edited by hand fails to load until tsk get pins it.
	assert.NoError(t, os.WriteFile(c.Config, []byte(`imports = ["github.com/acme/linters@v1.0.0//lib"]`), 0o600))
	_, err = project.Load(t.Context(), logger, fstest.MapFS{}, c, cache)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "github.com/acme/linters@v1.0.0//lib is locked as github.com/acme/linters@v1.1.0//lib")
	assert.Equal(t, "update github.com/acme/linters@v1.1.0//lib ("+second+") => v1.0.0 ("+first+")\n  - two\n", get())

	// A removed import is dropped from the lock file.
	assert.NoError(t, os.WriteFile(c.Config, nil, 0o600))
	assert.Equal(t, "remove github.com/acme/linters@v1.0.0//lib ("+first+")\n  - one\n", get())
	lock, err := library.LoadLock(c.LockFile())
	assert.NoError(t, err)
	assert.Equal(t, library.Lock{}, lock)
}
