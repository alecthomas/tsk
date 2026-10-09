package library

import (
	"archive/tar"
	"bytes"
	"context"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"

	"github.com/alecthomas/errors"
	. "github.com/alecthomas/types/optional"
	"golang.org/x/mod/semver"
)

// Config locates the library cache.
type Config struct {
	Cache string `help:"Cache of linter libraries and lint results. Defaults to tsk in the user cache directory." env:"TSK_CACHE" type:"path"`
}

// Resolve defaults the cache to tsk in userCache, the user cache directory.
func (c Config) Resolve(userCache Option[string]) (Config, error) {
	if c.Cache != "" {
		return c, nil
	}
	dir, ok := userCache.Get()
	if !ok {
		return Config{}, errors.New("no user cache directory; set TSK_CACHE or --cache")
	}
	c.Cache = filepath.Join(dir, "tsk")
	return c, nil
}

// Cache holds a bare mirror of each library repository, under git/, and
// each library at each pinned commit, under src/. Snapshots never change once
// written, so they are read without locking.
type Cache struct {
	dir    string
	logger *slog.Logger
}

// NewCache returns the cache c locates, which must be resolved.
func NewCache(c Config, logger *slog.Logger) *Cache {
	return &Cache{dir: c.Cache, logger: logger}
}

// Resolve fetches an import's repository and pins its version to a commit.
// Without a version it pins the highest semver tag, or the default branch
// when there is none.
func (c *Cache) Resolve(ctx context.Context, imported Import) (Locked, error) {
	repository, dir := imported.Repository, imported.Dir
	mirror := c.mirror(repository)
	unlock, err := lockFile(mirror + ".lock")
	if err != nil {
		return Locked{}, err
	}
	defer unlock()
	if err := c.fetch(ctx, repository, mirror); err != nil {
		return Locked{}, err
	}
	version, ok := imported.Version.Get()
	if !ok {
		if version, err = latest(ctx, mirror); err != nil {
			return Locked{}, err
		}
	}
	commit, err := git(ctx, mirror, "rev-parse", "--verify", "--quiet", version+"^{commit}")
	if err != nil {
		return Locked{}, errors.Errorf("%s has no version %s", repository, version)
	}
	if dir != "" {
		// A peel suffix would be read as part of the path, so check the type.
		if kind, err := git(ctx, mirror, "cat-file", "-t", commit+":"+dir); err != nil || kind != "tree" {
			return Locked{}, errors.Errorf("%s has no directory %s at %s", repository, dir, version)
		}
	}
	return Locked{Repository: repository, Version: version, Dir: dir, Commit: commit}, nil
}

// Snapshot returns the directory holding a locked library. A missing snapshot
// is extracted from the mirror, which is fetched if it lacks the commit, and
// which fetches the file contents the snapshot needs.
func (c *Cache) Snapshot(ctx context.Context, locked Locked) (string, error) {
	snapshot := filepath.Join(c.dir, "src", escape(locked.Path())+"@"+locked.Commit)
	if info, err := os.Stat(snapshot); err == nil && info.IsDir() {
		return snapshot, nil
	}
	mirror := c.mirror(locked.Repository)
	unlock, err := lockFile(mirror + ".lock")
	if err != nil {
		return "", err
	}
	defer unlock()
	// Another process may have extracted it while this one waited for the lock.
	if info, err := os.Stat(snapshot); err == nil && info.IsDir() {
		return snapshot, nil
	}
	if _, err := git(ctx, mirror, "cat-file", "-e", locked.Commit+"^{commit}"); err != nil {
		if err := c.fetch(ctx, locked.Repository, mirror); err != nil {
			return "", err
		}
	}
	c.logger.InfoContext(ctx, "Extracting library", "library", locked.String())
	staging, err := c.staging("snapshot-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(staging) //nolint:errcheck // Gone after a successful rename.
	if err := extract(ctx, mirror, locked.Commit, locked.Dir, staging); err != nil {
		return "", errors.Wrapf(err, "extract %s", locked)
	}
	if err := os.MkdirAll(filepath.Dir(snapshot), 0o750); err != nil {
		return "", errors.Wrap(err, "create snapshot directory")
	}
	// Renaming a complete snapshot into place means readers, which take no
	// lock, never see a partial one.
	return snapshot, errors.Wrap(os.Rename(staging, snapshot), "store snapshot")
}

func (c *Cache) mirror(repository string) string {
	return filepath.Join(c.dir, "git", escape(strings.TrimSuffix(repository, ".git"))+".git")
}

// staging creates a directory in tmp/, on the same file system as the cache,
// so it can be renamed into place.
func (c *Cache) staging(pattern string) (string, error) {
	tmp := filepath.Join(c.dir, "tmp")
	if err := os.MkdirAll(tmp, 0o750); err != nil {
		return "", errors.Wrap(err, "create cache staging directory")
	}
	dir, err := os.MkdirTemp(tmp, pattern)
	return dir, errors.Wrap(err, "create cache staging directory")
}

// fetch clones or updates a mirror. The caller holds the mirror's lock.
func (c *Cache) fetch(ctx context.Context, repository, mirror string) error {
	url := "https://" + repository
	if _, err := os.Stat(mirror); err == nil {
		c.logger.InfoContext(ctx, "Fetching library repository", "repository", repository)
		_, err := git(ctx, mirror, "fetch", "--quiet", "--prune", "--force", "origin",
			"+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*")
		return err
	}
	c.logger.InfoContext(ctx, "Cloning library repository", "repository", repository)
	staging, err := c.staging("mirror-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging) //nolint:errcheck // Gone after a successful rename.
	// Blobless: file contents are fetched only when a snapshot is extracted,
	// and only for its commit and directory. Servers without filter support
	// ignore it and send everything.
	if _, err := git(ctx, staging, "clone", "--bare", "--quiet", "--filter=blob:none", url, "."); err != nil {
		return err
	}
	// Cloned aside and renamed, so an interrupted clone leaves no mirror.
	return errors.Wrap(os.Rename(staging, mirror), "store mirror")
}

// latest returns a mirror's highest semver tag, or its default branch.
func latest(ctx context.Context, mirror string) (string, error) {
	tags, err := git(ctx, mirror, "tag", "--list")
	if err != nil {
		return "", err
	}
	highest := ""
	for tag := range strings.FieldsSeq(tags) {
		if semver.IsValid(tag) && (highest == "" || semver.Compare(tag, highest) > 0) {
			highest = tag
		}
	}
	if highest != "" {
		return highest, nil
	}
	return git(ctx, mirror, "symbolic-ref", "--short", "HEAD")
}

// extract writes the regular files under dir at commit into staging,
// read-only. Other entries, such as symbolic links, are skipped, because
// scripts are loaded only from regular files.
func extract(ctx context.Context, mirror, commit, dir, staging string) error {
	args := []string{"archive", "--format=tar", commit}
	if dir != "" {
		args = append(args, dir)
	}
	// Archiving a blobless mirror fetches file contents, so it may prompt too.
	command := gitCommand(ctx, mirror, args...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.StdoutPipe()
	if err != nil {
		return errors.Wrap(err, "git archive")
	}
	if err := command.Start(); err != nil {
		return errors.Wrap(err, "git archive")
	}
	if err := untar(output, dir, staging); err != nil {
		_ = command.Wait() //nolint:errcheck // The extraction error explains the failure.
		return err
	}
	if err := command.Wait(); err != nil {
		return errors.Errorf("git archive: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func untar(input io.Reader, dir, staging string) error {
	prefix := ""
	if dir != "" {
		prefix = dir + "/"
	}
	reader := tar.NewReader(input)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return errors.Wrap(err, "read archive")
		}
		name, ok := strings.CutPrefix(header.Name, prefix)
		name = strings.TrimSuffix(name, "/")
		if !ok || name == "" || header.Typeflag != tar.TypeReg {
			continue
		}
		if !filepath.IsLocal(name) {
			return errors.Errorf("archive entry %s escapes the library", header.Name)
		}
		if err := writeFile(filepath.Join(staging, filepath.FromSlash(name)), reader); err != nil {
			return err
		}
	}
}

// writeFile creates a read-only file. Directories stay writable so the cache
// can be deleted with ordinary tools.
func writeFile(path string, content io.Reader) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return errors.Wrap(err, "create directory")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o444) //nolint:gosec // The archive entry was checked to be local.
	if err != nil {
		return errors.Wrap(err, "create file")
	}
	_, err = io.Copy(file, content)
	closeErr := file.Close()
	if err != nil {
		return errors.Wrapf(err, "write %s", path)
	}
	return errors.Wrapf(closeErr, "write %s", path)
}

// git runs git in dir and returns its trimmed output.
func git(ctx context.Context, dir string, args ...string) (string, error) {
	command := gitCommand(ctx, dir, args...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		return "", errors.Errorf("git %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(output)), nil
}

// gitCommand returns a git command that runs on the repository in dir.
func gitCommand(ctx context.Context, dir string, args ...string) *exec.Cmd {
	command := exec.CommandContext(ctx, "git", args...)
	command.Dir = dir
	// Git hooks, such as one running tsk, export these to select the repository
	// being pushed; inherited, they would override dir. Config variables stay.
	selectors := []string{
		"GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_DIR", "GIT_GRAFT_FILE",
		"GIT_IMPLICIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_OBJECT_DIRECTORY",
		"GIT_PREFIX", "GIT_REPLACE_REF_BASE", "GIT_SHALLOW_FILE", "GIT_WORK_TREE",
	}
	command.Env = slices.DeleteFunc(command.Environ(), func(variable string) bool {
		name, _, _ := strings.Cut(variable, "=")
		return slices.Contains(selectors, name)
	})
	// tsk cannot answer a credential prompt, so git fails rather than waits.
	command.Env = append(command.Env, "GIT_TERMINAL_PROMPT=0")
	return command
}

// lockFile takes an exclusive lock on path, creating it, and returns the
// function that releases it. Concurrent git fetches into one mirror are unsafe.
func lockFile(path string) (unlock func(), err error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, errors.Wrap(err, "create lock directory")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600) //nolint:gosec // The path is built from a checked import path.
	if err != nil {
		return nil, errors.Wrap(err, "open lock")
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil { //nolint:gosec // File descriptors fit in an int.
		_ = file.Close() //nolint:errcheck // The lock error explains the failure.
		return nil, errors.Wrapf(err, "lock %s", path)
	}
	return func() {
		_ = file.Close() //nolint:errcheck // Closing releases the lock; nothing was written.
	}, nil
}
