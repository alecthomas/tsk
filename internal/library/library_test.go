package library_test

import (
	"testing"

	"github.com/alecthomas/assert/v2"
	. "github.com/alecthomas/types/optional"

	"github.com/alecthomas/tsk/internal/library"
)

func TestParseImport(t *testing.T) {
	tests := []struct {
		name     string
		text     string
		expected library.Import
		error    string
	}{
		{name: "Versioned", text: "github.com/acme/linters@v1.2.0", expected: library.Import{Repository: "github.com/acme/linters", Version: Some("v1.2.0")}},
		{name: "Unversioned", text: "github.com/acme/linters", expected: library.Import{Repository: "github.com/acme/linters", Version: None[string]()}},
		{name: "Dir", text: "github.com/acme/linters@v1.2.0//strict/go", expected: library.Import{Repository: "github.com/acme/linters", Version: Some("v1.2.0"), Dir: "strict/go"}},
		{name: "UnversionedDir", text: "github.com/acme/linters//strict", expected: library.Import{Repository: "github.com/acme/linters", Version: None[string](), Dir: "strict"}},
		{name: "BranchDir", text: "gitlab.com/acme/group/linters@feature/x//strict", expected: library.Import{Repository: "gitlab.com/acme/group/linters", Version: Some("feature/x"), Dir: "strict"}},
		{name: "VersionAfterDir", text: "github.com/acme/linters//strict@v1", error: `path element "strict@v1" contains '@'`},
		{name: "EmptyDir", text: "github.com/acme/linters//", error: `empty directory after "//"`},
		{name: "OptionVersion", text: "github.com/acme/linters@--upload-pack=x", error: `version "--upload-pack=x" cannot start with "-"`},
		{name: "EmptyVersion", text: "github.com/acme/linters@", error: "empty version"},
		{name: "NoHost", text: "acme/linters", error: `repository "acme/linters" must be a host name followed by a path`},
		{name: "HostOnly", text: "github.com", error: `repository "github.com" must be a host name followed by a path`},
		{name: "URL", text: "https://github.com/acme/linters", error: `repository "https:" must be a host name followed by a path`},
		{name: "BadCharacter", text: "github.com/acme/lin ters", error: `path element "lin ters" contains ' '`},
		{name: "DotElement", text: "github.com/acme/linters//../x", error: `path element ".." cannot start with '.'`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			imported, err := library.ParseImport(test.text)
			if test.error != "" {
				assert.Error(t, err)
				assert.Contains(t, err.Error(), test.error)
				return
			}
			assert.NoError(t, err)
			assert.Equal(t, test.expected, imported)
			assert.Equal(t, test.text, imported.String())
		})
	}
}

func TestCheckImports(t *testing.T) {
	tests := []struct {
		name    string
		imports []string
		error   string
	}{
		{name: "Distinct", imports: []string{"github.com/acme/a@v1", "github.com/acme/ab@v1"}},
		{name: "Siblings", imports: []string{"github.com/acme/a@v1//x", "github.com/acme/a@v1//y"}},
		{name: "Twice", imports: []string{"github.com/acme/a@v1", "github.com/acme/a@v2"}, error: "github.com/acme/a is imported twice"},
		{name: "SamePath", imports: []string{"github.com/acme/a@v1//x", "github.com/acme/a/x@v1"}, error: "github.com/acme/a/x is imported twice"},
		{name: "Nested", imports: []string{"github.com/acme/a@v1//x", "github.com/acme/a@v1"}, error: "imports github.com/acme/a@v1//x and github.com/acme/a@v1 overlap; import only one of them"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := library.CheckImports(parse(t, test.imports...))
			if test.error == "" {
				assert.NoError(t, err)
				return
			}
			assert.EqualError(t, err, test.error)
		})
	}
}

func TestLockCheck(t *testing.T) {
	commit := "0123456789abcdef0123456789abcdef01234567"
	lock := library.Lock{Imports: []library.Locked{{Repository: "github.com/acme/a", Version: "v1", Dir: "x", Commit: commit}}}
	tests := []struct {
		name    string
		imports []string
		error   string
	}{
		{name: "Matches", imports: []string{"github.com/acme/a@v1//x"}},
		{name: "Unlocked", imports: []string{"github.com/acme/a@v1//x", "github.com/acme/b@v1"}, error: "github.com/acme/b@v1 is not locked"},
		{name: "VersionChanged", imports: []string{"github.com/acme/a@v2//x"}, error: "github.com/acme/a@v2//x is locked as github.com/acme/a@v1//x"},
		{name: "RepositoryChanged", imports: []string{"github.com/acme/a/x@v1"}, error: "github.com/acme/a/x@v1 is locked as github.com/acme/a@v1//x"},
		{name: "Removed", imports: nil, error: "github.com/acme/a@v1//x is locked but not imported"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := lock.Check(parse(t, test.imports...))
			if test.error == "" {
				assert.NoError(t, err)
				return
			}
			assert.EqualError(t, err, test.error)
		})
	}
}

func parse(t *testing.T, texts ...string) []library.Import {
	t.Helper()
	imports := make([]library.Import, 0, len(texts))
	for _, text := range texts {
		imported, err := library.ParseImport(text)
		assert.NoError(t, err)
		imports = append(imports, imported)
	}
	return imports
}
