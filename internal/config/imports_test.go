package config_test

import (
	"testing"

	"github.com/alecthomas/assert/v2"
	. "github.com/alecthomas/types/optional"

	"github.com/alecthomas/tsk/internal/config"
	"github.com/alecthomas/tsk/internal/library"
)

func TestParseImports(t *testing.T) {
	tests := []struct {
		Name     string
		Text     string
		Expected []library.Import
		Error    string
	}{
		{Name: "Imports", Text: `imports = ["github.com/acme/a", "github.com/acme/b@main//x"]`, Expected: []library.Import{
			{Repository: "github.com/acme/a", Version: None[string]()},
			{Repository: "github.com/acme/b", Version: Some("main"), Dir: "x"},
		}},
		{Name: "Overlap", Text: `imports = ["github.com/acme/a", "github.com/acme/a//x"]`, Error: `test.toml: imports "github.com/acme/a" and "github.com/acme/a//x" overlap`},
		{Name: "BadPath", Text: `imports = ["acme"]`, Error: `repository "acme" must be a host name followed by a path`},
	}
	for _, test := range tests {
		t.Run(test.Name, func(t *testing.T) {
			file, err := config.Parse("test.toml", test.Text)
			if test.Error != "" {
				assert.Error(t, err)
				assert.Contains(t, err.Error(), test.Error)
				return
			}
			assert.NoError(t, err)
			assert.Equal(t, test.Expected, file.Imports)
		})
	}
}

func TestReplace(t *testing.T) {
	const imports = `imports = ["github.com/acme/a@v1.0.0//x", "github.com/acme/b"]` + "\n"
	tests := []struct {
		Name    string
		Replace string
		Error   string
	}{
		{Name: "Replaced", Replace: `replace = { "github.com/acme/a//x" = "../a" }`},
		{Name: "Table", Replace: "[replace]\n\"github.com/acme/a//x\" = \"../a\""},
		{Name: "Versioned", Replace: `replace = { "github.com/acme/a@v1.0.0//x" = "../a" }`, Error: `test.toml: replace "github.com/acme/a@v1.0.0//x": write the import without a version, as "github.com/acme/a//x"`},
		{Name: "NotImported", Replace: `replace = { "github.com/acme/a" = "../a" }`, Error: `test.toml: replace "github.com/acme/a": not imported`},
		{Name: "EmptyDir", Replace: `replace = { "github.com/acme/a//x" = "" }`, Error: `test.toml: replace "github.com/acme/a//x": empty directory`},
		{Name: "BadImport", Replace: `replace = { "acme" = "../a" }`, Error: `test.toml: replace: import "acme": repository "acme" must be a host name followed by a path`},
	}
	for _, test := range tests {
		t.Run(test.Name, func(t *testing.T) {
			file, err := config.Parse("test.toml", imports+test.Replace)
			if test.Error != "" {
				assert.EqualError(t, err, test.Error)
				return
			}
			assert.NoError(t, err)
			dir, ok := file.Replacement(file.Imports[0])
			assert.Equal(t, [2]any{"../a", true}, [2]any{dir, ok})
			_, ok = file.Replacement(file.Imports[1])
			assert.False(t, ok)
		})
	}
}

func TestSetImports(t *testing.T) {
	imports := []library.Import{
		{Repository: "github.com/acme/a", Version: None[string]()},
		{Repository: "github.com/acme/b", Version: Some("main"), Dir: "x"},
	}
	const setting = "imports = [\n  \"github.com/acme/a\",\n  \"github.com/acme/b@main//x\",\n]"
	tests := []struct {
		Name     string
		Text     string
		Expected string
	}{
		{Name: "Empty", Text: "", Expected: setting + "\n"},
		{
			Name:     "Added",
			Text:     "# Settings.\ndisable = [\"x\"]\n\n[x]\nimports = 1\n",
			Expected: setting + "\n\n# Settings.\ndisable = [\"x\"]\n\n[x]\nimports = 1\n",
		},
		{
			Name:     "Replaced",
			Text:     "# Libraries.\nimports = [\n  # Old.\n  \"github.com/acme/c\",\n] # Trailing.\ndisable = [\"x\"]\n",
			Expected: "# Libraries.\n" + setting + " # Trailing.\ndisable = [\"x\"]\n",
		},
	}
	for _, test := range tests {
		t.Run(test.Name, func(t *testing.T) {
			updated, err := config.SetImports([]byte(test.Text), imports)
			assert.NoError(t, err)
			assert.Equal(t, test.Expected, string(updated))
			file, err := config.Parse("test.toml", string(updated))
			assert.NoError(t, err)
			assert.Equal(t, imports, file.Imports)
		})
	}
}
