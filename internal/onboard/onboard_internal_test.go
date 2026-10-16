package onboard

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/alecthomas/assert/v2"
	. "github.com/alecthomas/types/optional"

	"github.com/alecthomas/tsk/internal/config"
	"github.com/alecthomas/tsk/internal/library"
	"github.com/alecthomas/tsk/internal/project"
)

func TestDefaultConfigLoads(t *testing.T) {
	pinned, err := library.ParseImport(lintersImport)
	assert.NoError(t, err)
	pinned.Version = Some("v0.0.0")
	assert.NoError(t, err)
	text, err := config.SetImports([]byte(defaultConfig), []library.Import{pinned})
	assert.NoError(t, err)
	file, err := config.Parse("config.toml", string(text))
	assert.NoError(t, err)
	assert.Equal(t, []library.Import{pinned}, file.Imports)

	// Load the config against the library in this commit, so every linter it
	// enables and every option it sets must exist.
	dir, err := filepath.Abs(filepath.Join("..", "..", "linters"))
	assert.NoError(t, err)
	replace := "replace = { " + strconv.Quote("github.com/alecthomas/tsk//linters") + " = " + strconv.Quote(dir) + " }\n"
	scripts := filepath.Join(t.TempDir(), ".tsk")
	assert.NoError(t, os.MkdirAll(scripts, 0o750))
	c := project.Config{Dir: scripts, Config: filepath.Join(scripts, "config.toml")}
	assert.NoError(t, os.WriteFile(c.Config, append([]byte(replace), text...), 0o600))
	logger := slog.New(slog.DiscardHandler)
	p, err := project.Load(t.Context(), logger, c, library.NewCache(library.Config{Cache: t.TempDir()}, logger))
	assert.NoError(t, err)
	_, err = p.Analyzers()
	assert.NoError(t, err)
}

func TestSetSection(t *testing.T) {
	block := beginMarker + "\nsection\n" + endMarker + "\n"
	tests := []struct {
		name     string
		text     string
		expected string
	}{
		{name: "Empty", text: "", expected: block},
		{name: "Appends", text: "# Rules\n\n- rule\n", expected: "# Rules\n\n- rule\n\n" + block},
		{name: "AppendsWithoutTrailingNewline", text: "# Rules", expected: "# Rules\n\n" + block},
		{
			name:     "ReplacesInPlace",
			text:     "# Before\n\n" + beginMarker + "\nold\n" + endMarker + "\n\n# After\n",
			expected: "# Before\n\n" + block + "\n# After\n",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			actual, err := setSection(test.text, "section\n")
			assert.NoError(t, err)
			assert.Equal(t, test.expected, actual)
		})
	}
}

func TestSetSectionUnterminated(t *testing.T) {
	_, err := setSection(beginMarker+"\nold\n", "section\n")
	assert.EqualError(t, err, beginMarker+" has no matching "+endMarker)
}

func TestWriteInstructions(t *testing.T) {
	section := beginMarker + "\n" + agentsSection + endMarker + "\n"
	tests := []struct {
		name string
		// setup prepares the repository root.
		setup func(t *testing.T, root string)
		// written lists the files written, in order.
		written  []string
		expected map[string]string
	}{
		{
			name:    "CreatesAgentsFile",
			setup:   func(*testing.T, string) {},
			written: []string{"AGENTS.md", ".agents/skills/tsk/SKILL.md"},
			expected: map[string]string{
				"AGENTS.md":                  section,
				".agents/skills/tsk/SKILL.md": skill,
			},
		},
		{
			name: "PrefersClaudeFile",
			setup: func(t *testing.T, root string) {
				t.Helper()
				assert.NoError(t, os.WriteFile(filepath.Join(root, "CLAUDE.md"), []byte("# Rules\n"), 0o600))
			},
			written: []string{"CLAUDE.md", ".claude/skills/tsk/SKILL.md"},
			expected: map[string]string{
				"CLAUDE.md":                   "# Rules\n\n" + section,
				".claude/skills/tsk/SKILL.md": skill,
			},
		},
		{
			name: "WritesBothFiles",
			setup: func(t *testing.T, root string) {
				t.Helper()
				assert.NoError(t, os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("# Agents\n"), 0o600))
				assert.NoError(t, os.WriteFile(filepath.Join(root, "CLAUDE.md"), []byte("# Claude\n"), 0o600))
			},
			written: []string{"AGENTS.md", ".agents/skills/tsk/SKILL.md", "CLAUDE.md", ".claude/skills/tsk/SKILL.md"},
			expected: map[string]string{
				"AGENTS.md":                   "# Agents\n\n" + section,
				".agents/skills/tsk/SKILL.md": skill,
				"CLAUDE.md":                   "# Claude\n\n" + section,
				".claude/skills/tsk/SKILL.md": skill,
			},
		},
		{
			name: "WritesThroughClaudeLink",
			setup: func(t *testing.T, root string) {
				t.Helper()
				assert.NoError(t, os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("# Rules\n"), 0o600))
				assert.NoError(t, os.Symlink("AGENTS.md", filepath.Join(root, "CLAUDE.md")))
			},
			written: []string{"AGENTS.md", ".agents/skills/tsk/SKILL.md", ".claude/skills/tsk/SKILL.md"},
			expected: map[string]string{
				"AGENTS.md":                   "# Rules\n\n" + section,
				"CLAUDE.md":                   "# Rules\n\n" + section,
				".agents/skills/tsk/SKILL.md": skill,
				".claude/skills/tsk/SKILL.md": skill,
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			test.setup(t, root)
			var out strings.Builder
			assert.NoError(t, writeInstructions(root, &out))
			assert.Equal(t, report("write", test.written), out.String())
			// Running again must change nothing.
			out.Reset()
			assert.NoError(t, writeInstructions(root, &out))
			assert.Equal(t, report("keep", test.written), out.String())
			actual := map[string]string{}
			for name := range test.expected {
				data, err := os.ReadFile(filepath.Join(root, name))
				assert.NoError(t, err)
				actual[name] = string(data)
			}
			assert.Equal(t, test.expected, actual)
		})
	}
}

// report returns the lines init prints when it does action to each file.
func report(action string, files []string) string {
	var lines strings.Builder
	for _, file := range files {
		lines.WriteString(action + " " + file + "\n")
	}
	return lines.String()
}

func TestIgnoreEditorFiles(t *testing.T) {
	tests := []struct {
		name     string
		existing string
		expected string
	}{
		{name: "Creates", existing: "", expected: "/types/\n/tsconfig.json\n"},
		{name: "AddsMissing", existing: "/types/", expected: "/types/\n/tsconfig.json\n"},
		{name: "KeepsOthers", existing: "*.log\n/tsconfig.json\n", expected: "*.log\n/tsconfig.json\n/types/\n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, ".gitignore")
			if test.existing != "" {
				assert.NoError(t, os.WriteFile(path, []byte(test.existing), 0o600))
			}
			assert.NoError(t, ignoreEditorFiles(dir, dir, io.Discard))
			data, err := os.ReadFile(path)
			assert.NoError(t, err)
			assert.Equal(t, test.expected, string(data))
			// Running again must change nothing.
			var out strings.Builder
			assert.NoError(t, ignoreEditorFiles(dir, dir, &out))
			assert.Equal(t, "keep .gitignore\n", out.String())
		})
	}
}
