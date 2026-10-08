// Package bindgen generates the Go registry and TypeScript declarations that
// expose a fixed set of Go packages to linter scripts.
package bindgen

import (
	"bytes"
	"go/format"
	"go/types"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/alecthomas/errors"
	"golang.org/x/tools/go/packages"
)

// Config controls where generated bindings are written.
type Config struct {
	Output string `help:"Directory for the generated registry; declarations go in its dts subdirectory." default:"internal/bindings" type:"path"`
}

// exposedPackage is a Go package scripts can import by its import path.
type exposedPackage struct {
	path string
	// members restricts the package to these members; nil exposes every
	// exported member.
	members []string
}

// exposedPackages lists the Go packages exposed to scripts. Scripts may read
// but not change the system, so os is limited to reads.
func exposedPackages() []exposedPackage {
	return []exposedPackage{
		{path: "go/ast"},
		{path: "go/build"},
		{path: "go/constant"},
		{path: "go/token"},
		{path: "go/types"},
		{path: "io/fs"},
		{path: "os", members: []string{
			"DirEntry", "ErrExist", "ErrNotExist", "ErrPermission", "FileInfo", "FileMode",
			"Getwd", "Lstat", "ReadDir", "ReadFile", "Readlink", "Stat",
		}},
		{path: "path/filepath"},
		{path: "golang.org/x/mod/modfile"},
		// Only the result type: the analyzer itself is "tsk/passes".buildssa.
		{path: "golang.org/x/tools/go/analysis/passes/buildssa", members: []string{"SSA"}},
		// Only the result type: the analyzer itself is "tsk/passes".ctrlflow.
		{path: "golang.org/x/tools/go/analysis/passes/ctrlflow", members: []string{"CFGs"}},
		{path: "golang.org/x/tools/go/ast/edge"},
		{path: "golang.org/x/tools/go/ast/inspector"},
		{path: "golang.org/x/tools/go/cfg"},
		{path: "golang.org/x/tools/go/ssa"},
		{path: "golang.org/x/tools/go/types/typeutil"},
	}
}

// Generate loads the exposed packages and writes the registry and declarations.
func Generate(config Config) error {
	exposed := exposedPackages()
	paths := make([]string, len(exposed))
	for i, pkg := range exposed {
		paths[i] = pkg.path
	}
	loaded, err := packages.Load(&packages.Config{Mode: packages.NeedName | packages.NeedTypes}, paths...)
	if err != nil {
		return errors.Wrap(err, "load packages")
	}
	if packages.PrintErrors(loaded) > 0 {
		return errors.New("exposed packages have errors")
	}
	model := newModel(loaded, exposed)
	registry, err := model.registry()
	if err != nil {
		return err
	}
	if err := writeFile(filepath.Join(config.Output, "registry_gen.go"), registry); err != nil {
		return err
	}
	declarations, err := model.declarations()
	if err != nil {
		return err
	}
	for _, name := range slices.Sorted(maps.Keys(declarations)) {
		if err := writeFile(filepath.Join(config.Output, "dts", name), declarations[name]); err != nil {
			return err
		}
	}
	return nil
}

func writeFile(path string, content []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return errors.Wrap(err, "create output directory")
	}
	return errors.Wrap(os.WriteFile(path, content, 0o600), "write generated file")
}

// model is the exposed API.
type model struct {
	packages []*types.Package
	// allowed maps exposed packages to their member allowlists; a nil
	// allowlist admits every exported member.
	allowed map[*types.Package][]string
}

func newModel(loaded []*packages.Package, exposed []exposedPackage) *model {
	m := &model{allowed: map[*types.Package][]string{}}
	for _, pkg := range loaded {
		m.packages = append(m.packages, pkg.Types)
		for _, spec := range exposed {
			if spec.path == pkg.PkgPath {
				m.allowed[pkg.Types] = spec.members
			}
		}
	}
	slices.SortFunc(m.packages, func(a, b *types.Package) int { return strings.Compare(a.Path(), b.Path()) })
	return m
}

// declarations renders every package, keyed by declaration file name.
func (m *model) declarations() (map[string][]byte, error) {
	files := map[string][]byte{}
	for _, pkg := range m.packages {
		declaration, err := newDeclarer(m, pkg).render(m.packages)
		if err != nil {
			return nil, err
		}
		files[strings.ReplaceAll(pkg.Path(), "/", "_")+".d.ts"] = declaration
	}
	return files, nil
}

// declares reports whether the generator declares an object: an exported,
// non-generic member of an exposed package that its allowlist admits.
func (m *model) declares(object types.Object) bool {
	allowed, ok := m.allowed[object.Pkg()]
	return ok && object.Exported() && !isGeneric(object) && (allowed == nil || slices.Contains(allowed, object.Name()))
}

// members returns a package's declared members in name order.
func (m *model) members(pkg *types.Package) []types.Object {
	var objects []types.Object
	for _, name := range pkg.Scope().Names() {
		if object := pkg.Scope().Lookup(name); m.declares(object) {
			objects = append(objects, object)
		}
	}
	return objects
}

func isGeneric(object types.Object) bool {
	switch object := object.(type) {
	case *types.Func:
		return object.Signature().TypeParams().Len() > 0
	case *types.TypeName:
		named, ok := object.Type().(*types.Named)
		return ok && named.TypeParams().Len() > 0
	}
	return false
}

// registry renders the Go side: values for every member, keyed by Go name.
func (m *model) registry() ([]byte, error) {
	var out bytes.Buffer
	out.WriteString("// Code generated by tsk-gen. DO NOT EDIT.\n\npackage bindings\n\nimport (\n\t\"reflect\"\n")
	for _, pkg := range m.packages {
		out.WriteString("\t\"" + pkg.Path() + "\"\n")
	}
	out.WriteString(")\n\n// Packages returns the Go packages exposed to scripts.\nfunc Packages() []Package {\n\treturn []Package{\n")
	for _, pkg := range m.packages {
		m.registryPackage(&out, pkg)
	}
	out.WriteString("\t}\n}\n\n")
	out.WriteString("// TupleResults returns the functions and methods whose (T, bool) results are\n// both values rather than a value and an ok flag.\n")
	out.WriteString("func TupleResults() map[string]bool {\n\treturn map[string]bool{\n")
	for _, key := range m.tupleResults() {
		out.WriteString("\t\t\"" + key + "\": true,\n")
	}
	out.WriteString("\t}\n}\n")
	formatted, err := format.Source(out.Bytes())
	return formatted, errors.Wrap(err, "format registry")
}

func (m *model) registryPackage(out *bytes.Buffer, pkg *types.Package) {
	var funcs, vars, consts, typeNames, errorVars, errorTypes []string
	for _, object := range m.members(pkg) {
		qualified := pkg.Name() + "." + object.Name()
		switch object := object.(type) {
		case *types.Func:
			funcs = append(funcs, "\""+object.Name()+"\": "+qualified)
		case *types.Var:
			vars = append(vars, "\""+object.Name()+"\": func() any { return "+qualified+" }")
			if isErrorVar(object) {
				errorVars = append(errorVars, strconv.Quote(object.Name()))
			}
		case *types.Const:
			consts = append(consts, "\""+object.Name()+"\": "+constValue(object, qualified))
		case *types.TypeName:
			typeNames = append(typeNames, "\""+object.Name()+"\": reflect.TypeFor["+qualified+"]()")
			if isErrorType(object) {
				errorTypes = append(errorTypes, strconv.Quote(object.Name()))
			}
		}
	}
	out.WriteString("\t\t{\n\t\t\tPath: \"" + pkg.Path() + "\",\n")
	writeMap(out, "Funcs", "map[string]any", funcs)
	writeMap(out, "Vars", "map[string]func() any", vars)
	writeMap(out, "Consts", "map[string]any", consts)
	writeMap(out, "Types", "map[string]reflect.Type", typeNames)
	writeList(out, "ErrorVars", errorVars)
	writeList(out, "ErrorTypes", errorTypes)
	out.WriteString("\t\t},\n")
}

func writeList(out *bytes.Buffer, field string, entries []string) {
	if len(entries) == 0 {
		return
	}
	out.WriteString("\t\t\t" + field + ": []string{" + strings.Join(entries, ", ") + "},\n")
}

// isErrorVar reports whether a variable is declared as an error class: its
// type, error or concrete, implements error. The runtime reads this from the
// registry rather than deciding again.
func isErrorVar(object *types.Var) bool {
	return types.Implements(object.Type(), errorInterface())
}

// isErrorType reports whether a type is declared as an error class: a named,
// non-interface type where T or *T implements error.
func isErrorType(object *types.TypeName) bool {
	named, ok := object.Type().(*types.Named)
	if !ok || types.IsInterface(named) {
		return false
	}
	return types.Implements(named, errorInterface()) || types.Implements(types.NewPointer(named), errorInterface())
}

func errorInterface() *types.Interface {
	iface, _ := types.Universe.Lookup("error").Type().Underlying().(*types.Interface)
	return iface
}

// constValue converts untyped constants so they fit in an any.
func constValue(object *types.Const, qualified string) string {
	basic, ok := object.Type().(*types.Basic)
	if !ok || basic.Info()&types.IsUntyped == 0 {
		return qualified
	}
	switch {
	case basic.Info()&types.IsInteger != 0:
		return "int64(" + qualified + ")"
	case basic.Info()&types.IsFloat != 0:
		return "float64(" + qualified + ")"
	}
	return qualified
}

func writeMap(out *bytes.Buffer, field, mapType string, entries []string) {
	if len(entries) == 0 {
		return
	}
	out.WriteString("\t\t\t" + field + ": " + mapType + "{\n")
	for _, entry := range entries {
		out.WriteString("\t\t\t\t" + entry + ",\n")
	}
	out.WriteString("\t\t\t},\n")
}

// tupleResults lists signatures shaped (T, bool) whose bool is named for
// something other than success, such as types.MissingMethod's wrongType.
func (m *model) tupleResults() []string {
	var keys []string
	for _, pkg := range m.packages {
		for _, object := range m.members(pkg) {
			switch object := object.(type) {
			case *types.Func:
				if isTuple(object.Signature()) {
					keys = append(keys, pkg.Path()+"."+object.Name())
				}
			case *types.TypeName:
				keys = append(keys, m.methodTuples(object)...)
			}
		}
	}
	slices.Sort(keys)
	return keys
}

func (m *model) methodTuples(object *types.TypeName) []string {
	named, ok := object.Type().(*types.Named)
	if !ok || types.IsInterface(named) {
		return nil
	}
	receiver := object.Pkg().Name() + "." + object.Name()
	keys := tupleMethods("*"+receiver, types.NewMethodSet(types.NewPointer(named)))
	return append(keys, tupleMethods(receiver, types.NewMethodSet(named))...)
}

// tupleMethods keys methods by the receiver's reflect type string, which is
// how the runtime looks them up.
func tupleMethods(receiver string, methods *types.MethodSet) []string {
	var keys []string
	for selection := range methods.Methods() {
		method := selection.Obj().(*types.Func)
		if method.Exported() && isTuple(method.Signature()) {
			keys = append(keys, receiver+"."+method.Name())
		}
	}
	return keys
}

// okNames are result names that mark a (T, bool) result as the ok idiom.
func okNames() []string {
	return []string{"", "ok", "found", "exists", "present", "has"}
}

func isTuple(signature *types.Signature) bool {
	results := signature.Results()
	if results.Len() != 2 {
		return false
	}
	last := results.At(1)
	basic, ok := last.Type().(*types.Basic)
	return ok && basic.Kind() == types.Bool && !slices.Contains(okNames(), resultName(last))
}

// resultName returns a result's declared name. Export data names unnamed
// results "#rv1" and so on, which count as unnamed.
func resultName(result *types.Var) string {
	if strings.HasPrefix(result.Name(), "#") {
		return ""
	}
	return result.Name()
}

// implementers returns renderers for the exposed concrete types implementing
// iface, or false if another unexported type might implement it.
func (m *model) implementers(pkg *types.Package, iface *types.Interface) (func(*declarer) []string, bool) {
	if iface.Empty() {
		return nil, false
	}
	var found []*types.TypeName
	// Only the interface's own package is searched. Go interfaces are
	// satisfied structurally, so types elsewhere can match without being meant
	// to, as types.Scope matches ast.Node. Names within a package are unique,
	// so union members' $type tags cannot collide.
	for _, name := range pkg.Scope().Names() {
		object, ok := pkg.Scope().Lookup(name).(*types.TypeName)
		if !ok || object.IsAlias() || types.IsInterface(object.Type()) || isGeneric(object) {
			continue
		}
		if !types.Implements(object.Type(), iface) && !types.Implements(types.NewPointer(object.Type()), iface) {
			continue
		}
		switch {
		case m.declares(object):
			found = append(found, object)
		case object.Exported():
			// An exported implementation that is not declared, such as
			// os.File, cannot appear in a union.
			return nil, false
		case !m.embeddedBase(object) && !slices.Contains(hiddenImplementers(), object.Pkg().Path()+"."+object.Name()):
			return nil, false
		}
	}
	if len(found) == 0 {
		return nil, false
	}
	return func(d *declarer) []string {
		names := make([]string, 0, len(found))
		for _, object := range found {
			names = append(names, d.reference(object))
		}
		return names
	}, true
}

// embeddedBase reports whether an unexported type is embedded by an exported
// struct, as types.object is. Such a base type is never a dynamic type itself,
// so it does not stop an interface from being a closed union.
func (m *model) embeddedBase(base *types.TypeName) bool {
	for _, name := range base.Pkg().Scope().Names() {
		object, ok := base.Pkg().Scope().Lookup(name).(*types.TypeName)
		if !ok || !object.Exported() {
			continue
		}
		if structure, isStruct := object.Type().Underlying().(*types.Struct); isStruct && embeds(structure, base) {
			return true
		}
	}
	return false
}
