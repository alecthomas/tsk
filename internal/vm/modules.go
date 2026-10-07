package vm

import (
	"encoding/json"
	"fmt"
	"maps"
	"path"
	"slices"
	"strings"
	"sync"

	"github.com/alecthomas/errors"
	"github.com/grafana/sobek"

	"github.com/alecthomas/tsktsk/internal/bindings"
	"github.com/alecthomas/tsktsk/internal/compile"
	"github.com/alecthomas/tsktsk/internal/hostapi"
	"github.com/alecthomas/tsktsk/internal/naming"
)

// entryModule names the synthetic module importing every script. It cannot
// collide with a script, whose names end in ".ts".
const entryModule = "."

// Modules is a parsed and linked module graph shared by every runtime. Sobek
// keeps evaluation state per runtime, so the records are runtime-independent.
type Modules struct {
	program *compile.Program
	sources map[string]string
	entry   *sobek.SourceTextModuleRecord
	records map[string]*sobek.SourceTextModuleRecord
	names   map[sobek.ModuleRecord]string
	// evaluating serialises evaluation, because the shared records are not
	// documented as safe for concurrent evaluation by different runtimes.
	evaluating sync.Mutex
}

// NewModules parses the compiled scripts and the host modules into one graph.
func NewModules(program *compile.Program) (*Modules, error) {
	m := &Modules{
		program: program,
		sources: maps.Clone(program.Modules),
		records: map[string]*sobek.SourceTextModuleRecord{},
		names:   map[sobek.ModuleRecord]string{},
	}
	m.sources["tsk"] = hostapi.Tsk
	m.sources["tsk/passes"] = hostapi.Passes
	for _, pkg := range bindings.Packages() {
		m.sources[pkg.Path] = packageModule(pkg)
	}
	var entry strings.Builder
	// The prelude defines GoIterable, which wrapping Go sequences needs.
	entry.WriteString("import \"tsk\";\n")
	for _, name := range program.Entries {
		specifier, _ := json.Marshal(name) //nolint:errcheck // Strings always encode.
		fmt.Fprintf(&entry, "import %s;\n", specifier)
	}
	record, err := sobek.ParseModule(entryModule, entry.String(), m.resolve)
	if err != nil {
		return nil, errors.Wrap(err, "parse entry module")
	}
	m.entry = record
	m.names[record] = entryModule
	if err := record.Link(); err != nil {
		return nil, errors.Wrap(err, "link modules")
	}
	return m, nil
}

// evaluate evaluates the module graph in rt, which settles synchronously
// because scripts may not use top-level await.
func (m *Modules) evaluate(rt *sobek.Runtime) *sobek.Promise {
	m.evaluating.Lock()
	defer m.evaluating.Unlock()
	return m.entry.Evaluate(rt)
}

// Program returns the compiled scripts the modules were built from.
func (m *Modules) Program() *compile.Program {
	return m.program
}

// packageModule is the source of a Go package's module. Its members come from
// the runtime's goPackage, under the names the declarations use.
func packageModule(pkg bindings.Package) string {
	var source strings.Builder
	fmt.Fprintf(&source, "const m = __tsk.goPackage(%q);\n", pkg.Path)
	for _, name := range exportNames(pkg) {
		fmt.Fprintf(&source, "export const %s = m[%q];\n", name, name)
	}
	return source.String()
}

// exportNames maps a package's members to the names scripts import. Functions
// are lowerCamelCase; types, constants, and variables keep their Go names.
func exportNames(pkg bindings.Package) []string {
	var names []string
	for name := range pkg.Funcs {
		names = append(names, naming.Function(name))
	}
	names = slices.AppendSeq(names, maps.Keys(pkg.Consts))
	names = slices.AppendSeq(names, maps.Keys(pkg.Vars))
	names = slices.AppendSeq(names, maps.Keys(pkg.Types))
	slices.Sort(names)
	return slices.Compact(names)
}

func (m *Modules) load(name string) (*sobek.SourceTextModuleRecord, error) {
	if record, ok := m.records[name]; ok {
		return record, nil
	}
	record, err := sobek.ParseModule(name, m.sources[name], m.resolve)
	if err != nil {
		return nil, errors.Wrapf(err, "parse module %s", name)
	}
	m.records[name] = record
	m.names[record] = name
	return record, nil
}

// resolve maps bare specifiers to host modules and relative specifiers to
// scripts in the importing script's source. Sobek links the whole graph with
// the entry module's resolver.
func (m *Modules) resolve(referencing any, specifier string) (sobek.ModuleRecord, error) {
	record, _ := referencing.(sobek.ModuleRecord)
	referrer, known := m.names[record]
	if !known {
		return nil, errors.Errorf("import %q has no referencing module", specifier)
	}
	if referrer == entryModule {
		return m.load(specifier)
	}
	if !strings.HasPrefix(specifier, "./") && !strings.HasPrefix(specifier, "../") {
		if _, ok := m.sources[specifier]; ok && !strings.HasSuffix(specifier, ".ts") {
			return m.load(specifier)
		}
		return nil, errors.Errorf("%s imports unknown module %q", referrer, specifier)
	}
	name := path.Join(path.Dir(referrer), specifier)
	source, _, _ := strings.Cut(referrer, "/")
	if !strings.HasPrefix(name, source+"/") {
		return nil, errors.Errorf("%s imports %q outside its source", referrer, specifier)
	}
	for _, candidate := range []string{name, name + ".ts"} {
		if _, ok := m.program.Modules[candidate]; ok {
			return m.load(candidate)
		}
	}
	return nil, errors.Errorf("%s imports %q, which is not a script", referrer, specifier)
}
