package lint

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/alecthomas/errors"

	"github.com/alecthomas/tsk/internal/inputs"
)

// Entries unused for longer than maxUnused are trimmed, at most once per
// trimInterval. An entry's use is refreshed at most once per touchInterval, so
// most hits do not write.
const (
	maxUnused     = 5 * 24 * time.Hour
	trimInterval  = 24 * time.Hour
	touchInterval = time.Hour
)

// Cache stores each package's findings under a key covering everything they
// depend on, so unchanged packages are not analysed again.
type Cache struct {
	dir string
}

// NewCache returns the cache in dir, which is created when first written.
func NewCache(dir string) *Cache {
	return &Cache{dir: dir}
}

// entry is one package's cached result.
type entry struct {
	// Observations are what analysing the package and its dependencies read
	// beyond their own files. They must be unchanged for the entry to be used.
	Observations []inputs.Observation `json:"observations"`
	Findings     []finding            `json:"findings"`
}

func (c *Cache) path(key string) string {
	return filepath.Join(c.dir, key[:2], key+".json")
}

// load returns the entry stored under key, if one was and it can be read.
func (c *Cache) load(key string) (entry, bool) {
	path := c.path(key)
	data, err := os.ReadFile(path)
	if err != nil {
		return entry{}, false
	}
	var e entry
	if json.Unmarshal(data, &e) != nil {
		return entry{}, false
	}
	now := time.Now()
	if info, err := os.Stat(path); err == nil && now.Sub(info.ModTime()) > touchInterval {
		_ = os.Chtimes(path, now, now) //nolint:errcheck // Refreshing use is best effort.
	}
	return e, true
}

// store writes an entry under key. Concurrent runs may store the same key, so
// the entry is written aside and renamed into place.
func (c *Cache) store(key string, e entry) error {
	data, err := json.Marshal(e)
	if err != nil {
		return errors.Wrap(err, "encode cache entry")
	}
	dir := filepath.Dir(c.path(key))
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return errors.Wrap(err, "create cache directory")
	}
	tmp, err := os.CreateTemp(dir, key+".*.tmp")
	if err != nil {
		return errors.Wrap(err, "create cache entry")
	}
	defer os.Remove(tmp.Name()) //nolint:errcheck // Gone once renamed.
	_, err = tmp.Write(data)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return errors.Wrap(err, "write cache entry")
	}
	return errors.Wrap(os.Rename(tmp.Name(), c.path(key)), "store cache entry")
}

// trim removes entries unused for longer than maxUnused, unless it has done
// so within trimInterval.
// Removing goes through an os.Root, so a symlink in the cache cannot redirect
// it outside.
func (c *Cache) trim(now time.Time) {
	root, err := os.OpenRoot(c.dir)
	if err != nil {
		return // Nothing is cached yet.
	}
	defer root.Close() //nolint:errcheck // Nothing was written through it that could fail on close.
	const marker = "trim.txt"
	if info, err := root.Stat(marker); err == nil && now.Sub(info.ModTime()) < trimInterval {
		return
	}
	_ = fs.WalkDir(root.FS(), ".", func(path string, d fs.DirEntry, err error) error { //nolint:errcheck // Trimming is best effort.
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".json") {
			return nil //nolint:nilerr // Unreadable entries are skipped.
		}
		if info, err := d.Info(); err == nil && now.Sub(info.ModTime()) > maxUnused {
			_ = root.Remove(path) //nolint:errcheck // As above.
		}
		return nil
	})
	if f, err := root.Create(marker); err == nil {
		_ = f.Close() //nolint:errcheck // An empty marker; only its time matters.
	}
}
