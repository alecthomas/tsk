package scripttest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/build"
	"go/parser"
	"go/scanner"
	"go/token"
	"go/types"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/alecthomas/errors"
	. "github.com/alecthomas/types/optional"
	"golang.org/x/tools/go/gcexportdata"
	"golang.org/x/tools/go/packages"
)

// storeFormat changes whenever the manifest format or what is prepared does,
// so older manifests are not read.
const storeFormat = "1"

// Store keeps the package graph of each case's test data, prepared once with
// the go command, so later runs only parse and type-check. Dependencies come
// from export data the store keeps, unless facts need their source.
type Store struct {
	dir string
	// toolchain identifies the Go toolchain and target that prepared packages
	// depend on.
	toolchain string
}

// NewStore returns a store under dir. Prepared packages depend on the
// toolchain and target go/build reports.
func NewStore(dir string) *Store {
	// A missing VERSION file leaves GOROOT alone to identify the toolchain.
	version, _ := os.ReadFile(filepath.Join(build.Default.GOROOT, "VERSION")) //nolint:errcheck // See above.
	toolchain := fmt.Sprintf("%q %q %s/%s cgo=%t", build.Default.GOROOT, version, build.Default.GOOS, build.Default.GOARCH, build.Default.CgoEnabled)
	return &Store{dir: dir, toolchain: toolchain}
}

// manifest is the prepared package graph for patterns in one test data
// directory.
type manifest struct {
	// GOARCH sizes types as the go command would.
	GOARCH string `json:"goarch"`
	// Packages are the test data's own packages, each after its imports.
	Packages []storedPackage `json:"packages"`
	// Exports holds the blob of export data for each dependency outside the
	// test data that a test data package imports, by package ID.
	Exports map[string]storedExport `json:"exports"`
}

// storedPackage is a test data package, loaded from source.
type storedPackage struct {
	ID              string                  `json:"id"`
	Name            string                  `json:"name"`
	PkgPath         string                  `json:"pkgPath"`
	Root            bool                    `json:"root,omitzero"`
	Module          Option[packages.Module] `json:"module,omitzero"`
	GoFiles         []string                `json:"goFiles,omitzero"`
	CompiledGoFiles []string                `json:"compiledGoFiles,omitzero"`
	OtherFiles      []string                `json:"otherFiles,omitzero"`
	IgnoredFiles    []string                `json:"ignoredFiles,omitzero"`
	EmbedFiles      []string                `json:"embedFiles,omitzero"`
	// Imports maps each import path to the imported package's ID.
	Imports map[string]string `json:"imports,omitzero"`
	Errors  []packages.Error  `json:"errors,omitzero"`
}

// storedExport is a dependency loaded from export data.
type storedExport struct {
	PkgPath string `json:"pkgPath"`
	// Blob is absent when the go command could not build the dependency, in
	// which case importing it fails with Errors.
	Blob   Option[string] `json:"blob,omitzero"`
	Errors []string       `json:"errors,omitzero"`
}

// Load returns the packages matching patterns in dir, the root of a
// GOPATH-style tree or a module, with their tests, preparing them first if
// the store does not have them. It returns only the matched packages.
// Dependencies outside dir come from export data unless facts need them
// loaded from source, as lint loads them.
func (s *Store) Load(dir string, patterns []string, facts bool) ([]*packages.Package, error) {
	key, err := s.key(dir, patterns, facts)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(s.dir, "manifests", key+".json")
	m, err := readManifest(path)
	if errors.Is(err, os.ErrNotExist) {
		m, err = s.prepare(dir, patterns, facts)
		if err != nil {
			return nil, err
		}
		err = writeAtomic(path, func(f *os.File) error { return errors.WithStack(json.NewEncoder(f).Encode(m)) })
	}
	if err != nil {
		return nil, err
	}
	return s.typeCheck(m)
}

// key identifies what prepared packages depend on: the toolchain, the
// patterns, how dependencies load, and every file in the test data directory.
func (s *Store) key(dir string, patterns []string, facts bool) (string, error) {
	h := sha256.New()
	h.Write(fmt.Appendf(nil, "format %s\ntoolchain %s\ndir %q\npatterns %q\nfacts %t\n", storeFormat, s.toolchain, dir, patterns, facts))
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || !entry.Type().IsRegular() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return errors.WithStack(err)
		}
		h.Write(fmt.Appendf(nil, "file %q %d\n", path, len(data)))
		h.Write(data)
		return nil
	})
	if err != nil {
		return "", errors.Wrapf(err, "hash %q", dir)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func readManifest(path string) (manifest, error) {
	var m manifest
	data, err := os.ReadFile(path)
	if err != nil {
		return m, errors.WithStack(err)
	}
	return m, errors.Wrapf(json.Unmarshal(data, &m), "read %q", path)
}

// prepare lists the packages matching patterns in dir, with the go command,
// and keeps the export data of their dependencies outside dir, unless facts
// need every package from source.
func (s *Store) prepare(dir string, patterns []string, facts bool) (manifest, error) {
	m := manifest{GOARCH: build.Default.GOARCH, Exports: map[string]storedExport{}}
	env := []string{"GOPATH=" + dir, "GO111MODULE=off", "GOWORK=off"}
	if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
		gowork := filepath.Join(dir, "go.work")
		if _, err := os.Stat(gowork); err != nil {
			gowork = "off"
		}
		env = []string{"GO111MODULE=on", "GOPROXY=off", "GOWORK=" + gowork}
	}
	mode := packages.NeedName | packages.NeedFiles | packages.NeedCompiledGoFiles | packages.NeedImports |
		packages.NeedDeps | packages.NeedExportFile | packages.NeedModule | packages.NeedEmbedFiles
	cfg := &packages.Config{Mode: mode, Dir: dir, Tests: true, Env: append(os.Environ(), env...)}
	roots, err := packages.Load(cfg, patterns...)
	if err != nil {
		return m, errors.Wrapf(err, "load %q", patterns)
	}
	if len(roots) == 0 {
		return m, errors.Errorf("no packages matched %q", patterns)
	}
	isRoot := map[*packages.Package]bool{}
	for _, pkg := range roots {
		if pkg.Name == "" {
			return m, errors.Errorf("failed to load %q: Errors=%v", pkg.PkgPath, pkg.Errors)
		}
		isRoot[pkg] = true
	}
	fromSource := func(pkg *packages.Package) bool {
		return facts || pkg.Dir == dir || strings.HasPrefix(pkg.Dir, dir+string(os.PathSeparator))
	}
	for pkg := range packages.Postorder(roots) {
		// The type checker provides unsafe itself.
		if !fromSource(pkg) || pkg.PkgPath == types.Unsafe.Path() {
			continue
		}
		stored := storedPackage{
			ID: pkg.ID, Name: pkg.Name, PkgPath: pkg.PkgPath, Root: isRoot[pkg],
			GoFiles: pkg.GoFiles, OtherFiles: pkg.OtherFiles, IgnoredFiles: pkg.IgnoredFiles, EmbedFiles: pkg.EmbedFiles,
			Imports: map[string]string{},
		}
		if pkg.Module != nil {
			stored.Module = Some(*pkg.Module)
		}
		// Exporting builds every package, but test data that type-checks
		// often does not build, such as functions declared for missing
		// assembly. The go command reports a build failure as one error that
		// starts with a "# package" header.
		stored.Errors = slices.DeleteFunc(slices.Clone(pkg.Errors), func(err packages.Error) bool {
			return err.Kind == packages.ListError && strings.HasPrefix(err.Msg, "# ")
		})
		if stored.CompiledGoFiles, err = s.keepCompiledFiles(dir, pkg.CompiledGoFiles); err != nil {
			return m, err
		}
		for path, imported := range pkg.Imports {
			stored.Imports[path] = imported.ID
			if _, ok := m.Exports[imported.ID]; ok || fromSource(imported) || imported.PkgPath == types.Unsafe.Path() {
				continue
			}
			if m.Exports[imported.ID], err = s.keepExport(imported); err != nil {
				return m, err
			}
		}
		m.Packages = append(m.Packages, stored)
	}
	return m, nil
}

// keepCompiledFiles returns the paths to load files from, keeping copies of
// those outside dir. Cgo writes the files it compiles to the go command's
// cache, which may evict them.
func (s *Store) keepCompiledFiles(dir string, files []string) ([]string, error) {
	kept := make([]string, 0, len(files))
	for _, file := range files {
		if !strings.HasPrefix(file, dir+string(os.PathSeparator)) {
			blob, err := s.keep(file)
			if err != nil {
				return nil, err
			}
			file = s.blobPath(blob)
		}
		kept = append(kept, file)
	}
	return kept, nil
}

// keepExport keeps a dependency's export data. Test data may import missing
// packages on purpose, so a dependency without export data keeps its errors.
func (s *Store) keepExport(pkg *packages.Package) (storedExport, error) {
	export := storedExport{PkgPath: pkg.PkgPath}
	for _, err := range pkg.Errors {
		export.Errors = append(export.Errors, err.Error())
	}
	if pkg.ExportFile == "" {
		return export, nil
	}
	blob, err := s.keep(pkg.ExportFile)
	if err != nil {
		return export, err
	}
	export.Blob = Some(blob)
	return export, nil
}

// keep copies a file into the store, named by its contents, and returns
// its name.
func (s *Store) keep(file string) (string, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return "", errors.WithStack(err)
	}
	sum := sha256.Sum256(data)
	name := hex.EncodeToString(sum[:]) + filepath.Ext(file)
	path := s.blobPath(name)
	if _, err := os.Stat(path); err == nil {
		return name, nil
	}
	return name, writeAtomic(path, func(f *os.File) error {
		_, err := f.Write(data)
		return errors.WithStack(err)
	})
}

func (s *Store) blobPath(name string) string {
	return filepath.Join(s.dir, "blobs", name)
}

// writeAtomic writes path with write, through a temporary file renamed into
// place, so concurrent runs never read a partial file.
func writeAtomic(path string, write func(f *os.File) error) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return errors.WithStack(err)
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return errors.WithStack(err)
	}
	defer os.Remove(f.Name()) //nolint:errcheck // Gone once renamed.
	if err := write(f); err != nil {
		f.Close() //nolint:errcheck // The write already failed.
		return err
	}
	if err := f.Close(); err != nil {
		return errors.WithStack(err)
	}
	return errors.WithStack(os.Rename(f.Name(), path))
}

// typeCheck parses and type-checks the manifest's packages, and returns its
// roots.
func (s *Store) typeCheck(m manifest) ([]*packages.Package, error) {
	fset := token.NewFileSet()
	sizes := types.SizesFor("gc", m.GOARCH)
	// exported holds every package export data has created, by path, as
	// gcexportdata requires.
	exported := map[string]*types.Package{}
	importExport := func(id string) (*types.Package, error) {
		export, ok := m.Exports[id]
		if !ok {
			return nil, errors.Errorf("no metadata for %q", id)
		}
		if pkg, ok := exported[export.PkgPath]; ok && pkg.Complete() {
			return pkg, nil
		}
		blob, ok := export.Blob.Get()
		if !ok {
			return nil, errors.Errorf("no export data for %q: %s", id, strings.Join(export.Errors, "; "))
		}
		f, err := os.Open(s.blobPath(blob))
		if err != nil {
			return nil, errors.WithStack(err)
		}
		defer f.Close() //nolint:errcheck // Read only.
		r, err := gcexportdata.NewReader(f)
		if err != nil {
			return nil, errors.Wrapf(err, "read export data for %q", id)
		}
		pkg, err := gcexportdata.Read(r, fset, exported, export.PkgPath)
		return pkg, errors.Wrapf(err, "read export data for %q", id)
	}
	loaded := map[string]*packages.Package{}
	var roots []*packages.Package
	for _, stored := range m.Packages {
		pkg := &packages.Package{
			ID: stored.ID, Name: stored.Name, PkgPath: stored.PkgPath, Fset: fset, TypesSizes: sizes,
			GoFiles: stored.GoFiles, CompiledGoFiles: stored.CompiledGoFiles, OtherFiles: stored.OtherFiles,
			IgnoredFiles: stored.IgnoredFiles, EmbedFiles: stored.EmbedFiles,
			Errors: stored.Errors, Imports: map[string]*packages.Package{},
		}
		if module, ok := stored.Module.Get(); ok {
			pkg.Module = &module
		}
		// Only packages loaded from source are imports here, so analyzers
		// never run on export data, which has no syntax.
		for path, id := range stored.Imports {
			if imported, ok := loaded[id]; ok {
				pkg.Imports[path] = imported
			}
		}
		checkPackage(pkg, stored, func(path string) (*types.Package, error) {
			if path == types.Unsafe.Path() {
				return types.Unsafe, nil
			}
			id, ok := stored.Imports[path]
			if !ok {
				return nil, errors.Errorf("no metadata for %q", path)
			}
			if imported, ok := loaded[id]; ok {
				return imported.Types, nil
			}
			return importExport(id)
		})
		pkg.IllTyped = len(pkg.Errors) > 0
		for _, imported := range pkg.Imports {
			pkg.IllTyped = pkg.IllTyped || imported.IllTyped
		}
		loaded[pkg.ID] = pkg
		if stored.Root {
			roots = append(roots, pkg)
		}
	}
	return roots, nil
}

// importerFunc adapts a function to types.Importer.
type importerFunc func(path string) (*types.Package, error)

// Import implements types.Importer.
func (f importerFunc) Import(path string) (*types.Package, error) {
	return f(path)
}

// checkPackage parses and type-checks pkg as go/packages does, recording
// errors in pkg.Errors.
func checkPackage(pkg *packages.Package, stored storedPackage, importer importerFunc) {
	for _, file := range pkg.CompiledGoFiles {
		f, err := parser.ParseFile(pkg.Fset, file, nil, parser.AllErrors|parser.ParseComments)
		if f != nil {
			pkg.Syntax = append(pkg.Syntax, f)
		}
		var list scanner.ErrorList
		switch {
		case errors.As(err, &list):
			for _, e := range list {
				pkg.Errors = append(pkg.Errors, packages.Error{Pos: e.Pos.String(), Msg: e.Msg, Kind: packages.ParseError})
			}
		case err != nil:
			pkg.Errors = append(pkg.Errors, packages.Error{Pos: "-", Msg: err.Error(), Kind: packages.ParseError})
		}
	}
	pkg.Types = types.NewPackage(pkg.PkgPath, pkg.Name)
	pkg.TypesInfo = &types.Info{
		Types:        map[ast.Expr]types.TypeAndValue{},
		Defs:         map[*ast.Ident]types.Object{},
		Uses:         map[*ast.Ident]types.Object{},
		Implicits:    map[ast.Node]types.Object{},
		Instances:    map[*ast.Ident]types.Instance{},
		Scopes:       map[ast.Node]*types.Scope{},
		Selections:   map[*ast.SelectorExpr]*types.Selection{},
		FileVersions: map[*ast.File]string{},
	}
	errored := false
	config := &types.Config{
		Importer: importer,
		Sizes:    pkg.TypesSizes,
		Error: func(err error) {
			errored = true
			var typeErr types.Error
			if errors.As(err, &typeErr) {
				pkg.Errors = append(pkg.Errors, packages.Error{Pos: typeErr.Fset.Position(typeErr.Pos).String(), Msg: typeErr.Msg, Kind: packages.TypeError})
				return
			}
			pkg.Errors = append(pkg.Errors, packages.Error{Pos: "-", Msg: err.Error(), Kind: packages.TypeError})
		},
	}
	if module, ok := stored.Module.Get(); ok && module.GoVersion != "" {
		config.GoVersion = "go" + module.GoVersion
	}
	err := types.NewChecker(config, pkg.Fset, pkg.Types, pkg.TypesInfo).Files(pkg.Syntax)
	if err != nil && !errored {
		pkg.Errors = append(pkg.Errors, packages.Error{Pos: "-", Msg: err.Error(), Kind: packages.UnknownError})
	}
}
