package scripttest_test

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/alecthomas/assert/v2"
	"golang.org/x/tools/go/packages"

	"github.com/alecthomas/tsk/internal/scripttest"
)

// writeGOPATH writes files into a new GOPATH-style test data directory.
func writeGOPATH(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, text := range files {
		path := filepath.Join(dir, "src", name)
		assert.NoError(t, os.MkdirAll(filepath.Dir(path), 0o750))
		assert.NoError(t, os.WriteFile(path, []byte(text), 0o600))
	}
	return dir
}

// loaded summarises a loaded package.
type loaded struct {
	ID       string
	Typed    bool
	Syntax   int
	Imports  []string
	IllTyped bool
	Errors   []string
}

func summarise(pkg *packages.Package) loaded {
	l := loaded{ID: pkg.ID, Typed: pkg.Types != nil && pkg.Types.Complete(), Syntax: len(pkg.Syntax), IllTyped: pkg.IllTyped}
	for path := range pkg.Imports {
		l.Imports = append(l.Imports, path)
	}
	slices.Sort(l.Imports)
	for _, err := range pkg.Errors {
		l.Errors = append(l.Errors, err.Msg)
	}
	return l
}

func TestStoreLoadsWithoutGoCommandOncePrepared(t *testing.T) {
	dir := writeGOPATH(t, map[string]string{
		"a/a.go": "package a\n\nimport (\n\t\"b\"\n\t\"fmt\"\n)\n\nfunc F() { fmt.Println(b.B) }\n",
		"b/b.go": "package b\n\nconst B = 1\n",
	})
	store := scripttest.NewStore(t.TempDir())
	roots, err := store.Load(dir, []string{"a"}, false)
	assert.NoError(t, err)
	// Only test data packages load from source; fmt comes from export data.
	expected := []loaded{{ID: "a", Typed: true, Syntax: 1, Imports: []string{"b"}}}
	assert.Equal(t, expected, []loaded{summarise(roots[0])})
	assert.Equal(t, 1, len(roots))

	// Prepared packages load without the go command.
	t.Setenv("PATH", "")
	roots, err = store.Load(dir, []string{"a"}, false)
	assert.NoError(t, err)
	assert.Equal(t, expected, []loaded{summarise(roots[0])})

	// Changed test data needs preparing again, which needs the go command.
	assert.NoError(t, os.WriteFile(filepath.Join(dir, "src", "b", "b.go"), []byte("package b\n\nconst B = 2\n"), 0o600))
	_, err = store.Load(dir, []string{"a"}, false)
	assert.Error(t, err)
}

func TestStoreLoadsDependenciesFromSourceForFacts(t *testing.T) {
	dir := writeGOPATH(t, map[string]string{"a/a.go": "package a\n\nimport \"errors\"\n\nvar E = errors.New(\"e\")\n"})
	roots, err := scripttest.NewStore(t.TempDir()).Load(dir, []string{"a"}, true)
	assert.NoError(t, err)
	assert.Equal(t, loaded{ID: "a", Typed: true, Syntax: 1, Imports: []string{"errors"}}, summarise(roots[0]))
	errorsPkg := summarise(roots[0].Imports["errors"])
	assert.True(t, errorsPkg.Syntax > 0 && errorsPkg.Typed && !errorsPkg.IllTyped, "%+v", errorsPkg)
}

func TestStoreReportsMissingImports(t *testing.T) {
	dir := writeGOPATH(t, map[string]string{"a/a.go": "package a\n\nimport _ \"missing\"\n"})
	roots, err := scripttest.NewStore(t.TempDir()).Load(dir, []string{"a"}, false)
	assert.NoError(t, err)
	a := summarise(roots[0])
	assert.True(t, a.IllTyped)
	assert.NotZero(t, len(a.Errors))
}
