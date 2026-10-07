package vm

import (
	"encoding/json"
	"go/token"
	"go/types"
	"reflect"

	"github.com/alecthomas/errors"
	"github.com/grafana/sobek"
	"golang.org/x/tools/go/analysis"

	"github.com/alecthomas/tsktsk/internal/facts"
)

// Environment is what one analyzer run needs beyond the analysis.Pass.
type Environment struct {
	Pass *analysis.Pass
	// Config is the analyzer's resolved config as JSON.
	Config json.RawMessage
	// Facts maps the analyzer's fact names to their pooled Go types.
	Facts map[string]reflect.Type
	// Analyzers maps required analyzers by name. Script analyzers' results are
	// JSON; host analyzers' results are Go values.
	Analyzers map[string]*analysis.Analyzer
}

// passBinding implements the Pass methods for one run.
type passBinding struct {
	rt      *sobek.Runtime
	bridge  *bridge
	helpers jsonHelpers
	env     Environment
	pass    *analysis.Pass
	// names maps pooled fact types back to fact names.
	names map[reflect.Type]string
}

func newPassBinding(rt *sobek.Runtime, b *bridge, helpers jsonHelpers, env Environment) *passBinding {
	p := &passBinding{rt: rt, bridge: b, helpers: helpers, env: env, pass: env.Pass, names: map[reflect.Type]string{}}
	for name, t := range env.Facts {
		p.names[t] = name
	}
	return p
}

// bind builds the script's Pass. handle is the analyzer's own handle.
func (p *passBinding) bind(handle *sobek.Object) (*sobek.Object, error) {
	env, b := p.env, p.bridge
	config, err := p.helpers.parse(p.rt.ToValue(string(env.Config)))
	if err != nil {
		return nil, errors.Errorf("parse config: %s", describeException(err))
	}
	if config, err = p.helpers.freeze(config); err != nil {
		return nil, errors.Errorf("freeze config: %s", describeException(err))
	}
	pass := p.rt.NewObject()
	properties := map[string]any{
		"analyzer":          handle,
		"fset":              b.wrap(reflect.ValueOf(env.Pass.Fset)),
		"files":             b.wrap(reflect.ValueOf(env.Pass.Files)),
		"otherFiles":        b.wrap(reflect.ValueOf(env.Pass.OtherFiles)),
		"ignoredFiles":      b.wrap(reflect.ValueOf(env.Pass.IgnoredFiles)),
		"pkg":               b.wrap(reflect.ValueOf(env.Pass.Pkg)),
		"typesInfo":         b.wrap(reflect.ValueOf(env.Pass.TypesInfo)),
		"typesSizes":        b.wrap(reflect.ValueOf(&env.Pass.TypesSizes).Elem()),
		"typeErrors":        b.wrap(reflect.ValueOf(env.Pass.TypeErrors)),
		"module":            p.module(),
		"config":            config,
		"report":            p.report,
		"resultOf":          p.resultOf,
		"readFile":          p.readFile,
		"importObjectFact":  p.importObjectFact,
		"exportObjectFact":  p.exportObjectFact,
		"importPackageFact": p.importPackageFact,
		"exportPackageFact": p.exportPackageFact,
		"allObjectFacts":    p.allObjectFacts,
		"allPackageFacts":   p.allPackageFacts,
	}
	for name, value := range properties {
		if err := pass.Set(name, value); err != nil {
			return nil, errors.Wrapf(err, "bind pass.%s", name)
		}
	}
	return pass, nil
}

func (p *passBinding) module() sobek.Value {
	module := p.pass.Module
	if module == nil {
		return sobek.Undefined()
	}
	object := p.rt.NewObject()
	for name, value := range map[string]string{"path": module.Path, "version": module.Version, "goVersion": module.GoVersion} {
		if err := object.Set(name, value); err != nil {
			panic(p.bridge.typeError("%v", err))
		}
	}
	return object
}

func (p *passBinding) report(call sobek.FunctionCall) sobek.Value {
	object := call.Argument(0).ToObject(p.rt)
	diagnostic := analysis.Diagnostic{
		Pos:      p.pos(object, "pos"),
		End:      p.pos(object, "end"),
		Category: p.text(object, "category"),
		Message:  p.text(object, "message"),
		URL:      p.text(object, "url"),
	}
	for _, fix := range p.bridge.objects(object.Get("suggestedFixes")) {
		suggested := analysis.SuggestedFix{Message: p.text(fix, "message")}
		for _, edit := range p.bridge.objects(fix.Get("textEdits")) {
			suggested.TextEdits = append(suggested.TextEdits, analysis.TextEdit{
				Pos:     p.pos(edit, "pos"),
				End:     p.pos(edit, "end"),
				NewText: []byte(p.text(edit, "newText")),
			})
		}
		diagnostic.SuggestedFixes = append(diagnostic.SuggestedFixes, suggested)
	}
	for _, related := range p.bridge.objects(object.Get("related")) {
		diagnostic.Related = append(diagnostic.Related, analysis.RelatedInformation{
			Pos:     p.pos(related, "pos"),
			End:     p.pos(related, "end"),
			Message: p.text(related, "message"),
		})
	}
	p.pass.Report(diagnostic)
	return sobek.Undefined()
}

func (p *passBinding) pos(object *sobek.Object, name string) token.Pos {
	value := object.Get(name)
	if isAbsent(value) {
		return token.NoPos
	}
	return token.Pos(value.ToInteger())
}

func (p *passBinding) text(object *sobek.Object, name string) string {
	value := object.Get(name)
	if isAbsent(value) {
		return ""
	}
	return value.String()
}

func (p *passBinding) resultOf(call sobek.FunctionCall) sobek.Value {
	name := call.Argument(0).ToObject(p.rt).Get("name").String()
	analyzer, ok := p.env.Analyzers[name]
	if !ok {
		panic(p.bridge.typeError("analyzer %s is not required by %s", name, p.pass.Analyzer.Name))
	}
	result := p.pass.ResultOf[analyzer]
	raw, isScript := result.(json.RawMessage)
	if !isScript {
		return p.bridge.wrap(reflect.ValueOf(result))
	}
	value, err := p.helpers.parse(p.rt.ToValue(string(raw)))
	if err != nil {
		panic(err)
	}
	return value
}

func (p *passBinding) readFile(call sobek.FunctionCall) sobek.Value {
	data, err := p.pass.ReadFile(call.Argument(0).String())
	if err != nil {
		panic(p.bridge.goError(err))
	}
	return p.rt.ToValue(string(data))
}

// factType returns the pooled type of the fact handle argument.
func (p *passBinding) factType(value sobek.Value) reflect.Type {
	name := value.ToObject(p.rt).Get("name").String()
	t, ok := p.env.Facts[name]
	if !ok {
		panic(p.bridge.typeError("fact %s is not declared by analyzer %s", name, p.pass.Analyzer.Name))
	}
	return t
}

func (p *passBinding) object(value sobek.Value) types.Object {
	unwrapped, err := p.bridge.unwrap(value, reflect.TypeFor[types.Object]())
	if err != nil || unwrapped.IsNil() {
		panic(p.bridge.typeError("expected a types.Object"))
	}
	return unwrapped.Interface().(types.Object) //nolint:forcetypeassert // unwrap converted it.
}

func (p *passBinding) pkg(value sobek.Value) *types.Package {
	unwrapped, err := p.bridge.unwrap(value, reflect.TypeFor[*types.Package]())
	if err != nil || unwrapped.IsNil() {
		panic(p.bridge.typeError("expected a *types.Package"))
	}
	return unwrapped.Interface().(*types.Package) //nolint:forcetypeassert // unwrap converted it.
}

func (p *passBinding) encode(t reflect.Type, value sobek.Value) facts.Fact {
	name := p.names[t]
	text, err := p.helpers.stringify(value)
	if err != nil {
		panic(err)
	}
	if sobek.IsUndefined(text) {
		panic(p.bridge.typeError("fact value is not JSON"))
	}
	fact := facts.New(t)
	fact.Set(name, []byte(text.String()))
	return fact
}

func (p *passBinding) decode(fact facts.Fact) sobek.Value {
	value, err := p.helpers.parse(p.rt.ToValue(string(fact.JSON())))
	if err != nil {
		panic(err)
	}
	frozen, err := p.helpers.freeze(value)
	if err != nil {
		panic(err)
	}
	return frozen
}

func (p *passBinding) importObjectFact(call sobek.FunctionCall) sobek.Value {
	fact := facts.New(p.factType(call.Argument(1)))
	if !p.pass.ImportObjectFact(p.object(call.Argument(0)), fact) {
		return sobek.Undefined()
	}
	return p.decode(fact)
}

func (p *passBinding) exportObjectFact(call sobek.FunctionCall) sobek.Value {
	p.pass.ExportObjectFact(p.object(call.Argument(0)), p.encode(p.factType(call.Argument(1)), call.Argument(2)))
	return sobek.Undefined()
}

func (p *passBinding) importPackageFact(call sobek.FunctionCall) sobek.Value {
	fact := facts.New(p.factType(call.Argument(1)))
	if !p.pass.ImportPackageFact(p.pkg(call.Argument(0)), fact) {
		return sobek.Undefined()
	}
	return p.decode(fact)
}

func (p *passBinding) exportPackageFact(call sobek.FunctionCall) sobek.Value {
	p.pass.ExportPackageFact(p.encode(p.factType(call.Argument(0)), call.Argument(1)))
	return sobek.Undefined()
}

func (p *passBinding) handle(t reflect.Type) sobek.Value {
	handle := p.rt.NewObject()
	if err := handle.Set("name", p.names[t]); err != nil {
		panic(p.bridge.typeError("%v", err))
	}
	return handle
}

func (p *passBinding) allObjectFacts(sobek.FunctionCall) sobek.Value {
	var items []any
	for _, found := range p.pass.AllObjectFacts() {
		fact, ok := found.Fact.(facts.Fact)
		if !ok || !p.owns(fact) {
			continue
		}
		item := p.rt.NewObject()
		p.setAll(item, map[string]any{
			"object": p.bridge.wrap(reflect.ValueOf(&found.Object).Elem()),
			"fact":   p.handle(reflect.TypeOf(fact)),
			"value":  p.decode(fact),
		})
		items = append(items, item)
	}
	return p.rt.NewArray(items...)
}

func (p *passBinding) allPackageFacts(sobek.FunctionCall) sobek.Value {
	var items []any
	for _, found := range p.pass.AllPackageFacts() {
		fact, ok := found.Fact.(facts.Fact)
		if !ok || !p.owns(fact) {
			continue
		}
		item := p.rt.NewObject()
		p.setAll(item, map[string]any{
			"package": p.bridge.wrap(reflect.ValueOf(found.Package)),
			"fact":    p.handle(reflect.TypeOf(fact)),
			"value":   p.decode(fact),
		})
		items = append(items, item)
	}
	return p.rt.NewArray(items...)
}

func (p *passBinding) setAll(object *sobek.Object, properties map[string]any) {
	for name, value := range properties {
		if err := object.Set(name, value); err != nil {
			panic(p.bridge.typeError("%v", err))
		}
	}
}

func (p *passBinding) owns(fact facts.Fact) bool {
	_, ok := p.names[reflect.TypeOf(fact)]
	return ok
}
