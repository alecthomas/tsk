// Package inputs tracks what linter scripts read from the file system, so a
// cached lint result can be checked against it.
package inputs

import (
	"bytes"
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/build"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
)

// Call is one tracked function call: the function's qualified Go name and
// its arguments as a JSON array of strings.
type Call struct {
	Func string `json:"func"`
	Args string `json:"args"`
}

func newCall(function string, args ...string) Call {
	encoded, _ := json.Marshal(args) //nolint:errcheck // Strings always encode.
	return Call{Func: function, Args: string(encoded)}
}

// Observation is a call and a digest of what it returned.
type Observation struct {
	Call   Call   `json:"call"`
	Digest string `json:"digest"`
}

// run makes a tracked call. It reports false for an unknown function or the
// wrong arguments, as a cache written by another version may hold.
func run(c Call) (outcome, bool) {
	arity := map[string]int{
		"os.Getwd": 0, "os.Lstat": 1, "os.ReadDir": 1, "os.ReadFile": 1, "os.Readlink": 1, "os.Stat": 1,
		"filepath.Abs": 1, "filepath.EvalSymlinks": 1, "filepath.Glob": 1, "build.Import": 3, "build.ImportDir": 2,
	}
	var args []string
	if want, known := arity[c.Func]; !known || json.Unmarshal([]byte(c.Args), &args) != nil || len(args) != want {
		return outcome{}, false
	}
	var value any
	var err error
	switch c.Func {
	case "os.Getwd":
		value, err = os.Getwd()
	case "os.Lstat":
		value, err = os.Lstat(args[0])
	case "os.ReadDir":
		value, err = os.ReadDir(args[0])
	case "os.ReadFile":
		value, err = os.ReadFile(args[0])
	case "os.Readlink":
		value, err = os.Readlink(args[0])
	case "os.Stat":
		value, err = os.Stat(args[0])
	case "filepath.Abs":
		value, err = filepath.Abs(args[0])
	case "filepath.EvalSymlinks":
		value, err = filepath.EvalSymlinks(args[0])
	case "filepath.Glob":
		value, err = filepath.Glob(args[0])
	case "build.Import":
		value, err = build.Import(args[0], args[1], importMode(args[2]))
	case "build.ImportDir":
		value, err = build.ImportDir(args[0], importMode(args[1]))
	}
	return outcome{value: value, err: err, digest: digest(value, err)}, true
}

func importMode(arg string) build.ImportMode {
	mode, _ := strconv.ParseUint(arg, 10, 64) //nolint:errcheck // Recorded by formatMode.
	return build.ImportMode(mode)
}

func formatMode(mode build.ImportMode) string {
	return strconv.FormatUint(uint64(mode), 10)
}

// outcome is a call's results and their digest.
type outcome struct {
	value  any
	err    error
	digest string
}

// digest summarises a result, including what a script can learn from a
// file's metadata, so any change a script could see changes it.
func digest(value any, err error) string {
	h := sha256.New()
	if err != nil {
		h.Write(fmt.Appendf(nil, "error %v", err))
		return hex.EncodeToString(h.Sum(nil))
	}
	switch value := value.(type) {
	case []byte:
		h.Write(value)
	case string:
		h.Write([]byte(value))
	case []string:
		h.Write(fmt.Appendf(nil, "%q", value))
	case []os.DirEntry:
		for _, entry := range value {
			h.Write(fmt.Appendf(nil, "%q %v\n", entry.Name(), entry.Type()))
		}
	case fs.FileInfo:
		h.Write(fmt.Appendf(nil, "%q %d %v %d", value.Name(), value.Size(), value.Mode(), value.ModTime().UnixNano()))
	case *build.Package:
		data, err := json.Marshal(value)
		if err != nil {
			data = fmt.Appendf(nil, "unencodable %v", err)
		}
		h.Write(data)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Recorder memoises tracked calls for one lint run, and records the package
// whose analysis made each. Memoising keeps one run's view of the file system
// consistent, and cheap when every package reads the same files.
type Recorder struct {
	mu       sync.Mutex
	outcomes map[Call]outcome
	// used maps import paths to the calls made while analysing them.
	used map[string]map[Call]bool
}

// NewRecorder returns a recorder with nothing recorded.
func NewRecorder() *Recorder {
	return &Recorder{outcomes: map[Call]outcome{}, used: map[string]map[Call]bool{}}
}

// For returns the tracked functions for analysing the package at an import
// path.
func (r *Recorder) For(pkg string) Reads {
	return newReads(r, pkg)
}

// Observations returns the calls made while analysing the packages at the
// import paths, sorted.
func (r *Recorder) Observations(pkgs []string) []Observation {
	r.mu.Lock()
	defer r.mu.Unlock()
	calls := map[Call]bool{}
	for _, pkg := range pkgs {
		for c := range r.used[pkg] {
			calls[c] = true
		}
	}
	observations := make([]Observation, 0, len(calls))
	for c := range calls {
		observations = append(observations, Observation{Call: c, Digest: r.outcomes[c].digest})
	}
	slices.SortFunc(observations, func(a, b Observation) int {
		return cmp.Or(cmp.Compare(a.Call.Func, b.Call.Func), cmp.Compare(a.Call.Args, b.Call.Args))
	})
	return observations
}

// Valid reports whether every call would return what it did when observed.
// A call is made at most once per run, so validating many cached results
// that read the same files stays cheap.
func (r *Recorder) Valid(observations []Observation) bool {
	for _, observation := range observations {
		o, ok := r.outcome(observation.Call)
		if !ok || o.digest != observation.Digest {
			return false
		}
	}
	return true
}

// outcome makes a call, or returns the outcome of making it earlier in the
// run. It reports false for a call naming an unknown function.
func (r *Recorder) outcome(c Call) (outcome, bool) {
	r.mu.Lock()
	o, done := r.outcomes[c]
	r.mu.Unlock()
	if done {
		return o, true
	}
	o, ok := run(c)
	if !ok {
		return outcome{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	// Another goroutine may have made the call too; the first outcome wins so
	// every caller in the run sees the same one.
	if earlier, raced := r.outcomes[c]; raced {
		return earlier, true
	}
	r.outcomes[c] = o
	return o, true
}

func (r *Recorder) record(pkg string, c Call) outcome {
	o, _ := r.outcome(c)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.used[pkg] == nil {
		r.used[pkg] = map[Call]bool{}
	}
	r.used[pkg][c] = true
	return o
}

// Reads are the tracked functions for one package's analysis. Each has the
// signature of the function it tracks.
type Reads struct {
	recorder *Recorder
	pkg      string
}

func newReads(recorder *Recorder, pkg string) Reads {
	return Reads{recorder: recorder, pkg: pkg}
}

// Getwd tracks os.Getwd.
func (r Reads) Getwd() (string, error) {
	o := r.recorder.record(r.pkg, newCall("os.Getwd"))
	return valueOf[string](o), o.err
}

// Lstat tracks os.Lstat.
func (r Reads) Lstat(name string) (fs.FileInfo, error) {
	o := r.recorder.record(r.pkg, newCall("os.Lstat", name))
	return valueOf[fs.FileInfo](o), o.err
}

// Stat tracks os.Stat.
func (r Reads) Stat(name string) (fs.FileInfo, error) {
	o := r.recorder.record(r.pkg, newCall("os.Stat", name))
	return valueOf[fs.FileInfo](o), o.err
}

// ReadDir tracks os.ReadDir. Each entry's Info is tracked as os.Lstat, which
// is what it calls.
func (r Reads) ReadDir(name string) ([]os.DirEntry, error) {
	o := r.recorder.record(r.pkg, newCall("os.ReadDir", name))
	entries := valueOf[[]os.DirEntry](o)
	tracked := make([]os.DirEntry, len(entries))
	for i, entry := range entries {
		tracked[i] = newDirEntry(entry, r, name)
	}
	return tracked, o.err
}

// ReadFile tracks os.ReadFile. Each caller gets its own copy of the shared
// contents.
func (r Reads) ReadFile(name string) ([]byte, error) {
	o := r.recorder.record(r.pkg, newCall("os.ReadFile", name))
	return bytes.Clone(valueOf[[]byte](o)), o.err
}

// Readlink tracks os.Readlink.
func (r Reads) Readlink(name string) (string, error) {
	o := r.recorder.record(r.pkg, newCall("os.Readlink", name))
	return valueOf[string](o), o.err
}

// Abs tracks filepath.Abs, which reads the working directory.
func (r Reads) Abs(path string) (string, error) {
	o := r.recorder.record(r.pkg, newCall("filepath.Abs", path))
	return valueOf[string](o), o.err
}

// EvalSymlinks tracks filepath.EvalSymlinks.
func (r Reads) EvalSymlinks(path string) (string, error) {
	o := r.recorder.record(r.pkg, newCall("filepath.EvalSymlinks", path))
	return valueOf[string](o), o.err
}

// Glob tracks filepath.Glob.
func (r Reads) Glob(pattern string) ([]string, error) {
	o := r.recorder.record(r.pkg, newCall("filepath.Glob", pattern))
	return slices.Clone(valueOf[[]string](o)), o.err
}

// Import tracks build.Import.
func (r Reads) Import(path, srcDir string, mode build.ImportMode) (*build.Package, error) {
	o := r.recorder.record(r.pkg, newCall("build.Import", path, srcDir, formatMode(mode)))
	return valueOf[*build.Package](o), o.err
}

// ImportDir tracks build.ImportDir.
func (r Reads) ImportDir(dir string, mode build.ImportMode) (*build.Package, error) {
	o := r.recorder.record(r.pkg, newCall("build.ImportDir", dir, formatMode(mode)))
	return valueOf[*build.Package](o), o.err
}

// valueOf returns an outcome's value, or T's zero value when the call failed
// without one.
func valueOf[T any](o outcome) T {
	value, _ := o.value.(T)
	return value
}

// dirEntry is a directory entry whose Info is tracked.
type dirEntry struct {
	os.DirEntry
	reads Reads
	dir   string
}

func newDirEntry(entry os.DirEntry, reads Reads, dir string) dirEntry {
	return dirEntry{DirEntry: entry, reads: reads, dir: dir}
}

// Info tracks the os.Lstat that os.DirEntry.Info makes.
func (e dirEntry) Info() (fs.FileInfo, error) {
	return e.reads.Lstat(filepath.Join(e.dir, e.Name()))
}
