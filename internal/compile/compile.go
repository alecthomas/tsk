// Package compile type-checks linter scripts against the host declarations
// and transpiles them to JavaScript modules.
package compile

import (
	"context"
	"io/fs"
	"path"
	"slices"
	"strconv"
	"strings"

	"github.com/alecthomas/errors"
	ts "github.com/microsoft/TypeScript/tsc/shim/typescript"

	"github.com/alecthomas/tsktsk/internal/bindings"
	"github.com/alecthomas/tsktsk/internal/config"
	"github.com/alecthomas/tsktsk/internal/hostapi"
)

const (
	// declarationsRoot holds the host declarations in the virtual program.
	declarationsRoot = "/@types/"
	// hostDeclaration is the virtual name of the "tsk" declarations.
	hostDeclaration = declarationsRoot + "tsk.d.ts"
	scriptExtension = ".ts"
)

// Source is one set of scripts. Its Name prefixes its module names, so it must
// be unique and contain no "/".
type Source struct {
	Name string
	FS   fs.FS
}

// Program is a checked and transpiled set of scripts.
type Program struct {
	// Modules maps module names, "<source>/<path>.ts", to JavaScript.
	Modules map[string]string
	// Entries lists every script module in evaluation order: sources in the
	// order given, then paths in sorted order.
	Entries []string
	// Schemas holds config shapes, indexed by the number the compiler inserts
	// as defineAnalyzer's first argument.
	Schemas []ts.Shape
}

// Compile type-checks every script in sources as one program, then transpiles
// each after inserting the schema index of its defineAnalyzer calls.
func Compile(ctx context.Context, sources []Source) (*Program, error) {
	files, err := declarationFiles()
	if err != nil {
		return nil, err
	}
	var scripts []string
	for _, source := range sources {
		found, err := readSource(source, files)
		if err != nil {
			return nil, err
		}
		scripts = append(scripts, found...)
	}
	program, err := ts.NewProgram(ctx, files)
	if err != nil {
		return nil, errors.Wrap(err, "type-check scripts")
	}
	compiled := &Program{Modules: map[string]string{}}
	for _, name := range scripts {
		source, err := insertSchemas(program, compiled, name, files[name])
		if err != nil {
			return nil, err
		}
		code, diagnostics := ts.Transpile(ctx, name, source)
		if len(diagnostics) > 0 {
			return nil, errors.Errorf("transpile %s: %s", name, strings.Join(diagnostics, "; "))
		}
		module := strings.TrimPrefix(name, "/")
		compiled.Modules[module] = code
		compiled.Entries = append(compiled.Entries, module)
	}
	return compiled, nil
}

// Declarations returns the host declaration files by base name, for editors.
func Declarations() (map[string]string, error) {
	files, err := declarationFiles()
	if err != nil {
		return nil, err
	}
	declarations := map[string]string{}
	for name, text := range files {
		declarations[strings.TrimPrefix(name, declarationsRoot)] = text
	}
	return declarations, nil
}

func declarationFiles() (map[string]string, error) {
	files := map[string]string{hostDeclaration: hostapi.Declaration}
	err := fs.WalkDir(bindings.Declarations, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return errors.WithStack(err)
		}
		data, err := fs.ReadFile(bindings.Declarations, name)
		files[declarationsRoot+path.Base(name)] = string(data)
		return errors.WithStack(err)
	})
	return files, errors.Wrap(err, "read generated declarations")
}

// readSource adds a source's .ts files to files and returns its scripts in
// sorted order. Symlinks are rejected because fs.FS cannot confine them, and
// testdata and types directories hold test inputs and editor declarations.
func readSource(source Source, files map[string]string) ([]string, error) {
	var scripts []string
	err := fs.WalkDir(source.FS, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return errors.Wrapf(err, "read %s scripts", source.Name)
		}
		switch {
		case entry.Type()&fs.ModeSymlink != 0:
			return errors.Errorf("%s/%s is a symbolic link", source.Name, name)
		case entry.IsDir() && (entry.Name() == "testdata" || entry.Name() == "types"):
			return fs.SkipDir
		case entry.IsDir() || path.Ext(name) != scriptExtension:
			return nil
		}
		data, err := fs.ReadFile(source.FS, name)
		if err != nil {
			return errors.Wrapf(err, "read %s/%s", source.Name, name)
		}
		virtual := "/" + source.Name + "/" + name
		files[virtual] = string(data)
		if !strings.HasSuffix(name, ".d.ts") {
			scripts = append(scripts, virtual)
		}
		return nil
	})
	slices.Sort(scripts)
	return scripts, errors.WithStack(err)
}

type insertion struct {
	offset int
	text   string
}

// insertSchemas passes each defineAnalyzer call its config shape's index, or
// -1 without a type argument, because transpilation erases the type.
func insertSchemas(program *ts.Program, compiled *Program, name, source string) (string, error) {
	calls, err := program.Calls(name, hostDeclaration, "defineAnalyzer")
	if err != nil {
		return "", errors.WithStack(err)
	}
	var insertions []insertion
	for _, call := range calls {
		index := -1
		if len(call.TypeArguments) > 0 {
			shape, err := program.Describe(call.TypeArguments[0])
			if err != nil {
				return "", errors.Errorf("%s: config type %s: %v", call.Location, program.TypeString(call.TypeArguments[0]), err)
			}
			if err := config.ValidateShape(shape); err != nil {
				return "", errors.Errorf("%s: config type: %v", call.Location, err)
			}
			index = len(compiled.Schemas)
			compiled.Schemas = append(compiled.Schemas, shape)
		}
		text := strconv.Itoa(index)
		if call.HasArguments {
			text += ", "
		}
		insertions = append(insertions, insertion{offset: call.Offset, text: text})
	}
	// Later offsets are applied first so earlier ones stay valid.
	slices.SortFunc(insertions, func(a, b insertion) int { return b.offset - a.offset })
	for _, inserted := range insertions {
		source = source[:inserted.offset] + inserted.text + source[inserted.offset:]
	}
	return source, nil
}
