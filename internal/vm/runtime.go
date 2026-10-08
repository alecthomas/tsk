package vm

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"reflect"
	"slices"
	"strconv"
	"strings"

	"github.com/alecthomas/errors"
	"github.com/grafana/sobek"

	"github.com/alecthomas/tsk/internal/bindings"
	"github.com/alecthomas/tsk/internal/compile"
	"github.com/alecthomas/tsk/internal/naming"
)

// Runtime is one sobek runtime with every module evaluated. It is confined to
// one goroutine at a time because sobek runtimes are not synchronised.
type Runtime struct {
	rt          *sobek.Runtime
	program     *compile.Program
	bridge      *bridge
	definitions map[string]definition
	order       []string
	overridden  []string
	hosts       map[*sobek.Object]string
	helpers     jsonHelpers
	logger      *slog.Logger
	// console is the logger console output goes to: logger, tagged with the
	// analyzer and package while one runs.
	console *slog.Logger
}

type definition struct {
	handle *sobek.Object
	object *sobek.Object
	schema int
	// module is the script module that called defineAnalyzer.
	module string
}

// helpers are captured before scripts run so scripts cannot replace them.
const helpers = `(function(stringify, parse, freeze, isFrozen, values) {
	const deepFreeze = (value) => {
		if (value !== null && typeof value === "object" && !isFrozen(value)) {
			freeze(value);
			values(value).forEach(deepFreeze);
		}
		return value;
	};
	return { stringify: (value) => stringify(value), parse: (text) => parse(text), freeze: deepFreeze };
})(JSON.stringify, JSON.parse, Object.freeze, Object.isFrozen, Object.values)`

// New creates a runtime and evaluates every module. Script console output goes
// to logger.
func New(modules *Modules, logger *slog.Logger) (*Runtime, error) {
	rt := sobek.New()
	rt.SetMaxCallStackSize(4096)
	r := &Runtime{
		rt:          rt,
		program:     modules.Program(),
		bridge:      newBridge(rt, bindings.TupleResults(), extensions()),
		definitions: map[string]definition{},
		hosts:       map[*sobek.Object]string{},
		logger:      logger,
		console:     logger,
	}
	if err := r.installHelpers(); err != nil {
		return nil, err
	}
	if err := r.installGlobals(); err != nil {
		return nil, err
	}
	promise := modules.evaluate(rt)
	switch promise.State() {
	case sobek.PromiseStateRejected:
		return nil, errors.Errorf("evaluate scripts: %s", describeException(promise.Result()))
	case sobek.PromiseStatePending:
		return nil, errors.New("evaluate scripts: top-level await is not supported")
	case sobek.PromiseStateFulfilled:
	}
	return r, nil
}

func (r *Runtime) installHelpers() error {
	value, err := r.rt.RunString(helpers)
	if err != nil {
		return errors.Wrap(err, "create helpers")
	}
	r.helpers, err = newJSONHelpers(value.ToObject(r.rt))
	return err
}

// jsonHelpers are JSON and freezing functions captured before scripts run.
type jsonHelpers struct {
	stringifyFunction sobek.Callable
	parseFunction     sobek.Callable
	freezeFunction    sobek.Callable
}

func newJSONHelpers(object *sobek.Object) (jsonHelpers, error) {
	var h jsonHelpers
	var ok [3]bool
	h.stringifyFunction, ok[0] = sobek.AssertFunction(object.Get("stringify"))
	h.parseFunction, ok[1] = sobek.AssertFunction(object.Get("parse"))
	h.freezeFunction, ok[2] = sobek.AssertFunction(object.Get("freeze"))
	if ok != [3]bool{true, true, true} {
		return jsonHelpers{}, errors.New("helpers are not callable")
	}
	return h, nil
}

// stringify returns undefined for values JSON cannot represent.
func (h jsonHelpers) stringify(value sobek.Value) (sobek.Value, error) {
	return h.stringifyFunction(sobek.Undefined(), value)
}

func (h jsonHelpers) parse(text sobek.Value) (sobek.Value, error) {
	return h.parseFunction(sobek.Undefined(), text)
}

// freeze deep-freezes and returns value.
func (h jsonHelpers) freeze(value sobek.Value) (sobek.Value, error) {
	return h.freezeFunction(sobek.Undefined(), value)
}

func (r *Runtime) installGlobals() error {
	console := r.rt.NewObject()
	native := r.rt.NewObject()
	for _, err := range []error{
		console.Set("debug", r.consoleWriter(slog.LevelDebug)),
		console.Set("log", r.consoleWriter(slog.LevelInfo)),
		console.Set("info", r.consoleWriter(slog.LevelInfo)),
		console.Set("warn", r.consoleWriter(slog.LevelWarn)),
		console.Set("error", r.consoleWriter(slog.LevelError)),
		r.rt.Set("console", console),
		native.Set("goPackage", r.goPackage),
		native.Set("setIterableFactory", r.setIterableFactory),
		native.Set("setErrorSupport", r.setErrorSupport),
		native.Set("combine", r.combine),
		native.Set("registerAnalyzer", r.registerAnalyzer),
		native.Set("hostAnalyzer", r.hostAnalyzer),
		r.rt.Set("__tsk", native),
	} {
		if err != nil {
			return errors.Wrap(err, "install globals")
		}
	}
	return nil
}

// consoleWriter logs a console call's arguments, joined by spaces, at level.
func (r *Runtime) consoleWriter(level slog.Level) func(sobek.FunctionCall) sobek.Value {
	return func(call sobek.FunctionCall) sobek.Value {
		parts := make([]string, len(call.Arguments))
		for i, argument := range call.Arguments {
			parts[i] = argument.String()
		}
		r.console.Log(context.Background(), level, strings.Join(parts, " "))
		return sobek.Undefined()
	}
}

func (r *Runtime) setIterableFactory(call sobek.FunctionCall) sobek.Value {
	factory, ok := sobek.AssertFunction(call.Argument(0))
	if !ok {
		panic(r.bridge.typeError("iterable factory must be a function"))
	}
	r.bridge.setIterableFactory(factory)
	return sobek.Undefined()
}

func (r *Runtime) setErrorSupport(call sobek.FunctionCall) sobek.Value {
	if err := r.bridge.setErrorSupport(call.Argument(0).ToObject(r.rt)); err != nil {
		panic(r.bridge.typeError("%v", err))
	}
	return sobek.Undefined()
}

func (r *Runtime) combine(call sobek.FunctionCall) sobek.Value {
	operands, ok := call.Argument(1).Export().([]any)
	if !ok {
		return sobek.Null()
	}
	values := make([]sobek.Value, len(operands))
	for i := range operands {
		values[i] = call.Argument(1).ToObject(r.rt).Get(strconv.Itoa(i))
	}
	return r.bridge.combine(call.Argument(0).String(), values)
}

// registerAnalyzer records a definition. A later definition with the same
// name replaces an earlier one, so project scripts override compiled-in ones.
// Two libraries defining one name is an error, as neither is meant to win.
func (r *Runtime) registerAnalyzer(call sobek.FunctionCall) sobek.Value {
	handle := call.Argument(0).ToObject(r.rt)
	object := call.Argument(1).ToObject(r.rt)
	name := object.Get("name")
	if name == nil || !isString(name) || name.String() == "" {
		panic(r.bridge.typeError("analyzer name must be a non-empty string"))
	}
	key := name.String()
	module := r.callerModule()
	if previous, exists := r.definitions[key]; exists {
		earlier, _ := r.program.Source(previous.module)
		later, _ := r.program.Source(module)
		if earlier != later && r.program.IsLibrary(earlier) && r.program.IsLibrary(later) {
			panic(r.bridge.typeError("analyzer %s is defined by both libraries %s and %s", key, earlier, later))
		}
		r.overridden = append(r.overridden, key)
	} else {
		r.order = append(r.order, key)
	}
	r.definitions[key] = definition{handle: handle, object: object, schema: int(call.Argument(2).ToInteger()), module: module}
	return sobek.Undefined()
}

// callerModule returns the module that called defineAnalyzer: the first
// stack frame in a script rather than the prelude or native code.
func (r *Runtime) callerModule() string {
	for _, frame := range r.rt.CaptureCallStack(0, nil) {
		if name := frame.SrcName(); name != "" && name != "tsk" && name != "<native>" {
			return name
		}
	}
	return ""
}

func isString(value sobek.Value) bool {
	_, ok := value.Export().(string)
	return ok
}

func (r *Runtime) hostAnalyzer(call sobek.FunctionCall) sobek.Value {
	handle := r.rt.NewObject()
	name := call.Argument(0).String()
	if err := handle.Set("name", name); err != nil {
		panic(r.bridge.typeError("%v", err))
	}
	r.hosts[handle] = name
	return handle
}

// goPackage builds a Go package's module members: functions, constants,
// variables, type tokens for structs, and receiver-first method namespaces
// for basic named types.
func (r *Runtime) goPackage(call sobek.FunctionCall) sobek.Value {
	path := call.Argument(0).String()
	for _, pkg := range bindings.Packages() {
		if pkg.Path == path {
			return r.packageObject(pkg)
		}
	}
	panic(r.bridge.typeError("unknown Go package %q", path))
}

func (r *Runtime) packageObject(pkg bindings.Package) *sobek.Object {
	b := r.bridge
	object := r.rt.NewObject()
	set := func(name string, value sobek.Value) {
		if err := object.Set(name, value); err != nil {
			panic(b.typeError("%v", err))
		}
	}
	for name, function := range pkg.Funcs {
		set(naming.Function(name), b.function(reflect.ValueOf(function), b.tuple(pkg.Path+"."+name)))
	}
	for name, value := range pkg.Consts {
		set(name, b.wrap(reflect.ValueOf(value)))
	}
	for name, value := range pkg.Vars {
		if slices.Contains(pkg.ErrorVars, name) {
			sentinel, ok := value().(error)
			if !ok || sentinel == nil {
				panic(b.typeError("error variable %s is nil", name))
			}
			class, err := b.sentinelClass(name, sentinel)
			if err != nil {
				panic(b.typeError("%v", err))
			}
			set(name, class)
			continue
		}
		set(name, b.wrap(reflect.ValueOf(value())))
	}
	for name, t := range pkg.Types {
		if slices.Contains(pkg.ErrorTypes, name) {
			class, err := b.errorTypeClass(t)
			if err != nil {
				panic(b.typeError("%v", err))
			}
			set(name, class)
			continue
		}
		if member, ok := r.typeMember(t); ok {
			set(name, member)
		}
	}
	return object
}

func (r *Runtime) typeMember(t reflect.Type) (sobek.Value, bool) {
	b := r.bridge
	switch t.Kind() { //nolint:exhaustive // Only basic kinds remain, which get method namespaces.
	case reflect.Struct:
		return b.newToken(reflect.PointerTo(t)), true
	case reflect.Interface, reflect.Func, reflect.Map, reflect.Slice, reflect.Array, reflect.Pointer, reflect.Chan:
		return nil, false
	}
	if t.NumMethod() == 0 {
		return nil, false
	}
	namespace := r.rt.NewObject()
	for method := range t.Methods() {
		function := b.function(method.Func, b.tuple(t.String()+"."+method.Name))
		if err := namespace.Set(naming.Member(method.Name), function); err != nil {
			panic(b.typeError("%v", err))
		}
	}
	return namespace, true
}

// Analyzers returns the registered analyzer names in registration order.
func (r *Runtime) Analyzers() []string {
	return r.order
}

// Overridden returns names registered more than once; the last wins.
func (r *Runtime) Overridden() []string {
	return r.overridden
}

// Requirement is one analyzer another requires.
type Requirement struct {
	Name string
	// Host is set for analyzers implemented in Go.
	Host bool
}

// Metadata describes a registered analyzer.
type Metadata struct {
	Name             string
	Doc              string
	URL              string
	Requires         []Requirement
	Facts            []string
	RunDespiteErrors bool
	// AllPackages is set when the analyzer's scope is "all": it also runs on
	// packages outside the module being linted.
	AllPackages bool
	// Schema indexes the compiled program's config shapes, or is -1.
	Schema int
	// Defaults is the config property as JSON, or null.
	Defaults json.RawMessage
	// Module is the script module that defined the analyzer, such as
	// "builtin/encapsulation.ts".
	Module string
}

// Metadata reads a registered analyzer's definition.
func (r *Runtime) Metadata(name string) (Metadata, error) {
	found, known := r.definitions[name]
	if !known {
		return Metadata{}, errors.Errorf("unknown analyzer %s", name)
	}
	object := found.object
	metadata := Metadata{Name: name, Schema: found.schema, Module: found.module}
	var err error
	if metadata.Doc, err = r.stringProperty(object, "doc", true); err != nil {
		return Metadata{}, errors.Errorf("analyzer %s: %v", name, err)
	}
	if metadata.URL, err = r.stringProperty(object, "url", false); err != nil {
		return Metadata{}, errors.Errorf("analyzer %s: %v", name, err)
	}
	if _, ok := sobek.AssertFunction(object.Get("run")); !ok {
		return Metadata{}, errors.Errorf("analyzer %s: run must be a function", name)
	}
	metadata.RunDespiteErrors = !isAbsent(object.Get("runDespiteErrors")) && object.Get("runDespiteErrors").ToBoolean()
	scope, err := r.stringProperty(object, "scope", false)
	if err != nil {
		return Metadata{}, errors.Errorf("analyzer %s: %v", name, err)
	}
	switch scope {
	case "", "module":
	case "all":
		metadata.AllPackages = true
	default:
		return Metadata{}, errors.Errorf("analyzer %s: scope must be \"module\" or \"all\", not %q", name, scope)
	}
	for _, handle := range r.bridge.objects(object.Get("requires")) {
		if host, ok := r.hosts[handle]; ok {
			metadata.Requires = append(metadata.Requires, Requirement{Name: host, Host: true})
			continue
		}
		metadata.Requires = append(metadata.Requires, Requirement{Name: handle.Get("name").String()})
	}
	for _, handle := range r.bridge.objects(object.Get("facts")) {
		metadata.Facts = append(metadata.Facts, handle.Get("name").String())
	}
	defaults := object.Get("config")
	if isAbsent(defaults) {
		metadata.Defaults = json.RawMessage("null")
	} else {
		text, err := r.helpers.stringify(defaults)
		if err != nil {
			return Metadata{}, errors.Errorf("analyzer %s: config is not JSON: %s", name, describeException(err))
		}
		metadata.Defaults = json.RawMessage(text.String())
	}
	return metadata, nil
}

func (r *Runtime) stringProperty(object *sobek.Object, name string, required bool) (string, error) {
	value := object.Get(name)
	if isAbsent(value) {
		if required {
			return "", errors.Errorf("%s is required", name)
		}
		return "", nil
	}
	if !isString(value) {
		return "", errors.Errorf("%s must be a string", name)
	}
	return value.String(), nil
}

// describeException renders a thrown value with its stack, which source maps
// point at the TypeScript lines.
func describeException(value any) string {
	switch value := value.(type) {
	case *sobek.Exception:
		return strings.TrimSpace(value.String())
	case sobek.Value:
		if object, ok := value.(*sobek.Object); ok {
			if stack := object.Get("stack"); stack != nil && !sobek.IsUndefined(stack) {
				return stack.String()
			}
		}
		return value.String()
	case error:
		return value.Error()
	}
	return fmt.Sprint(value)
}

// Run runs a registered analyzer's run function on one package and returns
// its result as JSON.
func (r *Runtime) Run(name string, env Environment) (result json.RawMessage, err error) {
	found, ok := r.definitions[name]
	if !ok {
		return nil, errors.Errorf("unknown analyzer %s", name)
	}
	run, ok := sobek.AssertFunction(found.object.Get("run"))
	if !ok {
		return nil, errors.Errorf("analyzer %s: run must be a function", name)
	}
	r.bridge.beginPass()
	defer r.bridge.endPass()
	r.console = r.logger.With("analyzer", name, "package", env.Pass.Pkg.Path())
	defer func() { r.console = r.logger }()
	pass, err := newPassBinding(r.rt, r.bridge, r.helpers, env).bind(found.handle)
	if err != nil {
		return nil, err
	}
	value, err := run(found.object, pass)
	if err != nil {
		return nil, errors.New(describeException(err))
	}
	if sobek.IsUndefined(value) {
		return json.RawMessage("null"), nil
	}
	text, err := r.helpers.stringify(value)
	if err != nil {
		return nil, errors.Errorf("result is not JSON: %s", describeException(err))
	}
	return json.RawMessage(text.String()), nil
}
