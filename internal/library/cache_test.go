package library_test

import (
	"log/slog"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/alecthomas/assert/v2"
	. "github.com/alecthomas/types/optional"

	"github.com/alecthomas/tsk/internal/library"
)

// remotes serves repositories from a directory: git rewrites https:// URLs
// to it, as a user's insteadOf setting would. Like hosted servers, it
// supports partial clones.
func remotes(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	// Git hooks export variables such as GIT_DIR naming the repository being
	// pushed; left set, test git commands would modify it.
	for key := range strings.FieldsSeq(run(t, root, "rev-parse", "--local-env-vars")) {
		t.Setenv(key, "")
		assert.NoError(t, os.Unsetenv(key))
	}
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

func run(t *testing.T, dir string, args ...string) string {
	t.Helper()
	command := exec.CommandContext(t.Context(), "git", args...)
	command.Dir = dir
	output, err := command.CombinedOutput()
	assert.NoError(t, err, "git %s: %s", strings.Join(args, " "), output)
	return strings.TrimSpace(string(output))
}

// commit writes files into a repository under root, creating it on main if
// needed, commits them, and returns the commit.
func commit(t *testing.T, root, repository string, files map[string]string) string {
	t.Helper()
	dir := filepath.Join(root, repository)
	if _, err := os.Stat(dir); err != nil {
		assert.NoError(t, os.MkdirAll(dir, 0o750))
		run(t, dir, "init", "--quiet", "--initial-branch=main")
	}
	for name, content := range files {
		path := filepath.Join(dir, name)
		assert.NoError(t, os.MkdirAll(filepath.Dir(path), 0o750))
		assert.NoError(t, os.WriteFile(path, []byte(content), 0o600))
	}
	run(t, dir, "add", "--all")
	run(t, dir, "commit", "--quiet", "--message=change")
	return run(t, dir, "rev-parse", "HEAD")
}

func newCache(t *testing.T) (*library.Cache, string) {
	t.Helper()
	dir := t.TempDir()
	return library.NewCache(library.Config{Cache: dir}, slog.New(slog.DiscardHandler)), dir
}

func TestConfigResolve(t *testing.T) {
	cwd, err := os.Getwd()
	assert.NoError(t, err)
	type resolved struct {
		Cache   string
		Results Option[string]
	}
	tests := []struct {
		name  string
		cache string
		want  resolved
	}{
		{name: "Default", want: resolved{Cache: "/user/tsk", Results: Some("/user/tsk/lint")}},
		{name: "Absolute", cache: "/elsewhere", want: resolved{Cache: "/elsewhere", Results: Some("/elsewhere/lint")}},
		{name: "Relative", cache: "here", want: resolved{Cache: filepath.Join(cwd, "here"), Results: Some(filepath.Join(cwd, "here", "lint"))}},
		{name: "Disable", cache: "disable", want: resolved{Cache: "/user/tsk", Results: None[string]()}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			c, err := library.Config{Cache: test.cache}.Resolve(Some("/user"))
			assert.NoError(t, err)
			assert.Equal(t, test.want, resolved{Cache: c.Cache, Results: c.Results()})
		})
	}
}

func TestResolve(t *testing.T) {
	root := remotes(t)
	const repository = "github.com/acme/linters"
	first := commit(t, root, repository, map[string]string{"lib/a.ts": "1"})
	run(t, filepath.Join(root, repository), "tag", "v1.0.0")
	second := commit(t, root, repository, map[string]string{"lib/a.ts": "2"})
	run(t, filepath.Join(root, repository), "tag", "v1.2.0")
	run(t, filepath.Join(root, repository), "tag", "release")
	head := commit(t, root, repository, map[string]string{"lib/a.ts": "3"})
	untagged := commit(t, root, "git.example.com/acme/untagged", map[string]string{"a.ts": "1"})
	tests := []struct {
		name     string
		imported string
		expected library.Locked
		error    string
	}{
		{name: "Tag", imported: repository + "@v1.0.0//lib", expected: library.Locked{Repository: repository, Version: "v1.0.0", Dir: "lib", Commit: first}},
		{name: "LatestTag", imported: repository, expected: library.Locked{Repository: repository, Version: "v1.2.0", Commit: second}},
		{name: "Branch", imported: repository + "@main", expected: library.Locked{Repository: repository, Version: "main", Commit: head}},
		{name: "ShortCommit", imported: repository + "@" + first[:10], expected: library.Locked{Repository: repository, Version: first[:10], Commit: first}},
		{name: "LatestBranch", imported: "git.example.com/acme/untagged", expected: library.Locked{Repository: "git.example.com/acme/untagged", Version: "main", Commit: untagged}},
		{name: "UnknownVersion", imported: repository + "@v9.0.0", error: "github.com/acme/linters has no version v9.0.0"},
		{name: "MissingDirectory", imported: repository + "@v1.0.0//missing", error: "github.com/acme/linters has no directory missing at v1.0.0"},
	}
	cache, _ := newCache(t)
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			imported, err := library.ParseImport(test.imported)
			assert.NoError(t, err)
			locked, err := cache.Resolve(t.Context(), imported)
			if test.error != "" {
				assert.EqualError(t, err, test.error)
				return
			}
			assert.NoError(t, err)
			assert.Equal(t, test.expected, locked)
		})
	}
}

func TestSnapshot(t *testing.T) {
	root := remotes(t)
	const repository = "github.com/Acme/linters"
	commit(t, root, repository, map[string]string{"lib/a.ts": "a", "lib/sub/b.ts": "b", "other.ts": "other"})
	assert.NoError(t, os.Symlink("a.ts", filepath.Join(root, repository, "lib", "link.ts")))
	first := commit(t, root, repository, nil)
	cache, dir := newCache(t)
	locked, err := cache.Resolve(t.Context(), library.Import{Repository: repository, Version: Some("main"), Dir: "lib"})
	assert.NoError(t, err)
	assert.Equal(t, first, locked.Commit)

	snapshot, err := cache.Snapshot(t.Context(), locked)
	assert.NoError(t, err)
	assert.Equal(t, filepath.Join(dir, "src", "github.com", "!acme", "linters", "lib@"+first), snapshot)
	assert.Equal(t, map[string]string{"a.ts": "a", "sub/b.ts": "b"}, readTree(t, snapshot))
	info, err := os.Stat(filepath.Join(snapshot, "a.ts"))
	assert.NoError(t, err)
	assert.Equal(t, os.FileMode(0o444), info.Mode().Perm())
	mirror := filepath.Join(dir, "git", "github.com", "!acme", "linters.git")
	assert.Equal(t, "blob:none", run(t, mirror, "config", "remote.origin.partialclonefilter"))

	// A commit the mirror lacks is fetched.
	second := commit(t, root, repository, map[string]string{"lib/a.ts": "changed"})
	snapshot, err = cache.Snapshot(t.Context(), library.Locked{Repository: repository, Version: "main", Dir: "lib", Commit: second})
	assert.NoError(t, err)
	assert.Equal(t, map[string]string{"a.ts": "changed", "sub/b.ts": "b"}, readTree(t, snapshot))

	// An existing snapshot needs neither the mirror nor the remote.
	assert.NoError(t, os.RemoveAll(filepath.Join(root, repository)))
	assert.NoError(t, os.RemoveAll(filepath.Join(dir, "git")))
	snapshot, err = cache.Snapshot(t.Context(), locked)
	assert.NoError(t, err)
	assert.Equal(t, []string{"a.ts", "sub/b.ts"}, slices.Sorted(maps.Keys(readTree(t, snapshot))))
}

func TestCacheInsideGitHook(t *testing.T) {
	root := remotes(t)
	const repository = "github.com/acme/linters"
	head := commit(t, root, repository, map[string]string{"lib/a.ts": "a"})
	hooked := t.TempDir()
	run(t, hooked, "init", "--quiet")
	t.Setenv("GIT_DIR", filepath.Join(hooked, ".git"))
	t.Setenv("GIT_WORK_TREE", hooked)
	t.Setenv("GIT_INDEX_FILE", filepath.Join(hooked, ".git", "index"))
	cache, _ := newCache(t)
	locked, err := cache.Resolve(t.Context(), library.Import{Repository: repository, Version: Some("main"), Dir: "lib"})
	assert.NoError(t, err)
	assert.Equal(t, library.Locked{Repository: repository, Version: "main", Dir: "lib", Commit: head}, locked)
	snapshot, err := cache.Snapshot(t.Context(), locked)
	assert.NoError(t, err)
	assert.Equal(t, map[string]string{"a.ts": "a"}, readTree(t, snapshot))
	assert.Equal(t, "", run(t, hooked, "for-each-ref"))
}

func readTree(t *testing.T, dir string) map[string]string {
	t.Helper()
	files := map[string]string{}
	err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(dir, path)
		files[filepath.ToSlash(relative)] = string(data)
		return err
	})
	assert.NoError(t, err)
	return files
}
