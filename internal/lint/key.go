package lint

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	"github.com/alecthomas/errors"
	"golang.org/x/tools/go/packages"
)

// keyer computes packages' content keys. A package's content key covers the
// run's scope, its own files, and its dependencies' content keys, so a change
// to any file changes the keys of every package depending on it. The scripts
// are left to cacheKey, so keys can be computed while scripts compile.
type keyer struct {
	// scope covers what every package's findings depend on besides the
	// scripts: tsk, and the Go toolchain and environment.
	scope string
	// immutable holds directories whose files never change under the same Go
	// toolchain: GOROOT and the module cache.
	immutable []string
	// keys memoises each package's key by ID; "" marks one that cannot be
	// cached.
	keys map[string]string
}

// newKeyer reads the Go environment that dir resolves.
func newKeyer(ctx context.Context, test bool, dir string) (*keyer, error) {
	command := exec.CommandContext(ctx, "go", "env", "-json")
	command.Dir = dir
	goEnv, err := command.Output()
	if err != nil {
		return nil, errors.Wrap(err, "go env")
	}
	var env map[string]string
	if err := json.Unmarshal(goEnv, &env); err != nil {
		return nil, errors.Wrap(err, "decode go env")
	}
	executable, err := executableDigest()
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	h.Write(fmt.Appendf(nil, "tsk %s\ntest %t\n", executable, test))
	// GOGCCFLAGS names a fresh temporary directory each time, so it would make
	// every key unique; its other flags follow from GOOS and GOARCH.
	delete(env, "GOGCCFLAGS")
	for _, name := range slices.Sorted(maps.Keys(env)) {
		h.Write(fmt.Appendf(nil, "env %s=%q\n", name, env[name]))
	}
	var immutable []string
	for _, name := range []string{"GOROOT", "GOMODCACHE"} {
		if env[name] != "" {
			immutable = append(immutable, filepath.Clean(env[name])+string(filepath.Separator))
		}
	}
	return &keyer{scope: hex.EncodeToString(h.Sum(nil)), immutable: immutable, keys: map[string]string{}}, nil
}

// executableDigest identifies the running tsk, whose built-in behaviour and
// bindings affect every finding.
func executableDigest() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", errors.Wrap(err, "find executable")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", errors.Wrap(err, "read executable")
	}
	defer f.Close() //nolint:errcheck // Read only.
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", errors.Wrap(err, "read executable")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// key returns a package's content key, or false if it cannot be cached, as
// when it or a dependency failed to load or a file cannot be read.
func (k *keyer) key(pkg *packages.Package) (string, bool) {
	if key, done := k.keys[pkg.ID]; done {
		return key, key != ""
	}
	key := k.compute(pkg)
	k.keys[pkg.ID] = key
	return key, key != ""
}

// cacheKey is the key of a package's findings: its content key with the
// fingerprint of the scripts and their settings.
func cacheKey(fingerprint, contentKey string) string {
	sum := sha256.Sum256(fmt.Appendf(nil, "scripts %s\ncontent %s\n", fingerprint, contentKey))
	return hex.EncodeToString(sum[:])
}

func (k *keyer) compute(pkg *packages.Package) string {
	if len(pkg.Errors) > 0 || (pkg.Module != nil && pkg.Module.Error != nil) {
		return ""
	}
	h := sha256.New()
	h.Write(fmt.Appendf(nil, "scope %s\npackage %q\n", k.scope, pkg.ID))
	files := slices.Concat(pkg.GoFiles, pkg.OtherFiles, pkg.IgnoredFiles, pkg.EmbedFiles)
	slices.Sort(files)
	for _, file := range slices.Compact(files) {
		digest, ok := k.fileDigest(file)
		if !ok {
			return ""
		}
		h.Write(fmt.Appendf(nil, "file %q %s\n", file, digest))
	}
	for _, path := range slices.Sorted(maps.Keys(pkg.Imports)) {
		key, ok := k.key(pkg.Imports[path])
		if !ok {
			return ""
		}
		h.Write(fmt.Appendf(nil, "import %q %s\n", path, key))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// fileDigest hashes a file's contents, except in an immutable directory,
// where its name is enough.
func (k *keyer) fileDigest(file string) (string, bool) {
	if slices.ContainsFunc(k.immutable, func(dir string) bool { return strings.HasPrefix(file, dir) }) {
		return "immutable", true
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return "", false
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), true
}
