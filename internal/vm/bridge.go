// Package vm runs linter scripts in sobek and converts values between Go and
// JavaScript.
package vm

import (
	"fmt"
	"reflect"
	"strconv"
	"strings"

	"github.com/alecthomas/errors"
	. "github.com/alecthomas/types/optional"
	"github.com/grafana/sobek"

	"github.com/alecthomas/tsk/internal/naming"
)

// bridge converts values for one runtime. It is confined to the runtime's
// goroutine because sobek runtimes are not synchronised.
type bridge struct {
	rt         *sobek.Runtime
	tuples     map[string]bool
	extensions map[reflect.Type]map[string]reflect.Value
	prototypes map[reflect.Type]*sobek.Object
	mapProto   *sobek.Object
	tokens     map[*sobek.Object]reflect.Type
	// global holds values wrapped while modules evaluate; it lives as long as
	// the runtime. current is the active pass's scope, or global.
	global          *scope
	current         *scope
	iterableFactory sobek.Callable
	// errorClasses is present once the prelude has defined GoError.
	errorClasses Option[*errorClasses]
}

// scope owns the wrappers created during one pass. Wrapping is cached by Go
// identity so the same Go value is the same JavaScript object, which scripts
// rely on for === and Map keys.
type scope struct {
	objects map[any]*sobek.Object
	values  map[*sobek.Object]reflect.Value
	natives map[*sobek.Object]native
	bound   map[boundKey]*sobek.Object
	// thrown maps exceptions to the Go errors they were thrown for, which
	// may wrap the typed error the exception exposes.
	thrown map[*sobek.Object]error
	stops  []func()
}

type boundKey struct {
	receiver *sobek.Object
	name     string
}

func newScope() *scope {
	return &scope{
		objects: map[any]*sobek.Object{},
		values:  map[*sobek.Object]reflect.Value{},
		natives: map[*sobek.Object]native{},
		bound:   map[boundKey]*sobek.Object{},
		thrown:  map[*sobek.Object]error{},
	}
}

func newBridge(rt *sobek.Runtime, tuples map[string]bool, extensions map[reflect.Type]map[string]reflect.Value) *bridge {
	global := newScope()
	b := &bridge{
		rt:         rt,
		tuples:     tuples,
		extensions: extensions,
		prototypes: map[reflect.Type]*sobek.Object{},
		tokens:     map[*sobek.Object]reflect.Type{},
		global:     global,
		current:    global,
	}
	b.mapProto = b.newMapPrototype()
	return b
}

// setIterableFactory records the prelude's GoIterable constructor.
func (b *bridge) setIterableFactory(factory sobek.Callable) {
	b.iterableFactory = factory
}

// tuple reports whether a function's (T, bool) results are both values. key
// is "<package path>.<function>" or "<receiver type>.<method>".
func (b *bridge) tuple(key string) bool {
	return b.tuples[key]
}

// newToken creates a type token standing for a typed nil of pointer type t.
func (b *bridge) newToken(t reflect.Type) *sobek.Object {
	token := b.rt.NewObject()
	if err := token.Set("name", typeName(t)); err != nil {
		panic(b.typeError("%v", err))
	}
	b.tokens[token] = t
	return token
}

// beginPass starts a scope that endPass discards, releasing its wrappers and
// stopping any sequence a script left unfinished.
func (b *bridge) beginPass() {
	b.current = newScope()
}

func (b *bridge) endPass() {
	for _, stop := range b.current.stops {
		stop()
	}
	b.current = b.global
}

func (b *bridge) lookup(object *sobek.Object) (reflect.Value, bool) {
	if value, ok := b.current.values[object]; ok {
		return value, true
	}
	value, ok := b.global.values[object]
	return value, ok
}

func (b *bridge) cached(key any) (*sobek.Object, bool) {
	if object, ok := b.current.objects[key]; ok {
		return object, true
	}
	object, ok := b.global.objects[key]
	return object, ok
}

func (b *bridge) remember(object *sobek.Object, value reflect.Value, key any, cacheable bool) {
	b.current.values[object] = value
	if cacheable {
		b.current.objects[key] = object
	}
}

// setErrorSupport installs the prelude's GoError and its helpers.
func (b *bridge) setErrorSupport(support *sobek.Object) error {
	classes, err := newErrorClasses(b.rt, support)
	if err != nil {
		return err
	}
	b.errorClasses = Some(classes)
	return nil
}

// goError creates the exception thrown for a Go error. It has the class of
// the first exposed error type in the wrap chain, with that error's fields,
// or is a plain GoError.
func (b *bridge) goError(err error) *sobek.Object {
	classes, ok := b.errorClasses.Get()
	if !ok {
		return b.rt.NewGoError(err) // Only before the prelude runs.
	}
	prototype := classes.errorPrototype()
	typed, found := classes.typed(err)
	if found {
		prototype = b.prototype(typed.Type())
	}
	exception, createErr := classes.exception(prototype, b.rt.ToValue(err.Error()))
	if createErr != nil {
		return b.rt.NewGoError(err)
	}
	if found {
		// Not cached by identity: wrapping the same error later must give an
		// ordinary wrapper, not this exception.
		b.remember(exception, typed, nil, false)
	}
	b.current.thrown[exception] = err
	return exception
}

// thrownError returns the Go error an exception was thrown for.
func (b *bridge) thrownError(object *sobek.Object) (error, bool) {
	if err, ok := b.current.thrown[object]; ok {
		return err, true
	}
	err, ok := b.global.thrown[object]
	return err, ok
}

// errorOf returns the Go error a value holds: a thrown exception's error, or a
// wrapped Go value implementing error.
func (b *bridge) errorOf(value sobek.Value) (error, bool) {
	object, isObject := value.(*sobek.Object)
	if !isObject {
		return nil, false
	}
	if err, ok := b.thrownError(object); ok {
		return err, true
	}
	if wrapped, ok := b.lookup(object); ok {
		return reflect.TypeAssert[error](wrapped)
	}
	return nil, false
}

// sentinelClass returns the class for an error variable. Its instanceof asks
// errors.Is, so os.ErrNotExist matches a thrown *fs.PathError.
func (b *bridge) sentinelClass(name string, sentinel error) (*sobek.Object, error) {
	matches := b.rt.ToValue(func(call sobek.FunctionCall) sobek.Value {
		err, ok := b.errorOf(call.Argument(0))
		return b.rt.ToValue(ok && errors.Is(err, sentinel))
	})
	classes, ok := b.errorClasses.Get()
	if !ok {
		return nil, errors.New("error classes are not defined yet")
	}
	class, err := classes.sentinelClass(b.rt.ToValue(name), sentinel, matches)
	return class, errors.WithStack(err)
}

// errorTypeClass returns the class for an exposed error type.
func (b *bridge) errorTypeClass(t reflect.Type) (*sobek.Object, error) {
	classes, ok := b.errorClasses.Get()
	if !ok {
		return nil, errors.New("error classes are not defined yet")
	}
	class, err := classes.errorTypeClass(b.rt.ToValue(typeName(t)), b.prototype(t))
	return class, errors.WithStack(err)
}

func (b *bridge) typeError(format string, args ...any) *sobek.Object {
	return b.rt.NewTypeError(fmt.Sprintf(format, args...))
}

// isAbsent reports whether a JavaScript value is missing: undefined, null,
// or the nil sobek's Get returns for a property that does not exist.
func isAbsent(value sobek.Value) bool {
	//nolint:optionalnil // sobek represents a missing property as nil.
	return value == nil || sobek.IsUndefined(value) || sobek.IsNull(value)
}

// objects returns the elements of a JavaScript array, or none for undefined
// or null.
func (b *bridge) objects(value sobek.Value) []*sobek.Object {
	if isAbsent(value) {
		return nil
	}
	array := value.ToObject(b.rt)
	length := int(array.Get("length").ToInteger())
	objects := make([]*sobek.Object, 0, length)
	for i := range length {
		objects = append(objects, array.Get(strconv.Itoa(i)).ToObject(b.rt))
	}
	return objects
}

// wrap converts a Go value to JavaScript. Nil pointers, interfaces, and
// functions become null; nil slices become empty arrays.
func (b *bridge) wrap(value reflect.Value) sobek.Value {
	if !value.IsValid() {
		return sobek.Null()
	}
	switch value.Kind() { //nolint:exhaustive // Other kinds need no special case.
	case reflect.Interface:
		if value.IsNil() {
			return sobek.Null()
		}
		// A value used through an interface's methods keeps them, even when
		// its dynamic type is basic, as constant.Value's implementations are.
		if element := value.Elem(); value.NumMethod() > 0 && isBasic(element.Kind()) && element.NumMethod() > 0 {
			return b.object(element)
		}
		return b.wrap(value.Elem())
	case reflect.Pointer:
		// Pointers to slices and interfaces have no methods of their own, so
		// they read as their target, as ssa.Value.Referrers' *[]Instruction.
		if kind := value.Type().Elem().Kind(); kind == reflect.Slice || kind == reflect.Interface {
			if value.IsNil() {
				return b.wrap(reflect.Zero(value.Type().Elem()))
			}
			return b.wrap(value.Elem())
		}
		if value.IsNil() {
			return sobek.Null()
		}
	case reflect.Func, reflect.Chan, reflect.UnsafePointer:
		if value.IsNil() {
			return sobek.Null()
		}
	}
	// Values of error types are instances of their class, whatever their kind,
	// as their declarations say; modfile.ErrorList is a slice.
	if classes, ok := b.errorClasses.Get(); ok && classes.isErrorType(value.Type()) {
		return b.object(value)
	}
	switch value.Kind() { //nolint:exhaustive // Remaining kinds are wrapped as objects.
	case reflect.Bool:
		return b.rt.ToValue(value.Bool())
	case reflect.String:
		return b.rt.ToValue(value.String())
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return b.rt.ToValue(value.Int())
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return b.rt.ToValue(value.Uint())
	case reflect.Float32, reflect.Float64:
		return b.rt.ToValue(value.Float())
	case reflect.Slice, reflect.Array:
		return b.array(value)
	case reflect.Map:
		return b.mapView(value)
	case reflect.Func:
		if isSequence(value.Type()) {
			return b.sequence(value)
		}
		return b.function(value, false)
	case reflect.Complex64, reflect.Complex128:
		return sobek.Undefined()
	}
	return b.object(value)
}

func (b *bridge) array(value reflect.Value) sobek.Value {
	if value.Kind() == reflect.Slice && value.Type().Elem().Kind() == reflect.Uint8 {
		return b.rt.ToValue(string(value.Bytes()))
	}
	items := make([]any, value.Len())
	for i := range value.Len() {
		items[i] = b.wrap(value.Index(i))
	}
	return b.rt.NewArray(items...)
}

// identity returns the key that caches a value's wrapper. Pointers, maps,
// channels, and basic values have identity. Struct values do not: Go compares
// them field by field, and hashing one costs a comparability walk and an
// allocation per wrap, so each wrap of a cursor or position is a new object.
func identity(value reflect.Value) (any, bool) {
	switch value.Kind() { //nolint:exhaustive // Other kinds need no special case.
	case reflect.Map:
		return mapIdentity{pointer: value.Pointer(), t: value.Type()}, true
	case reflect.Func, reflect.Struct:
		return nil, false
	}
	if !value.CanInterface() {
		return nil, false
	}
	return value.Interface(), true
}

type mapIdentity struct {
	pointer uintptr
	t       reflect.Type
}

// object wraps a struct, pointer, or other opaque value with its type's
// prototype.
func (b *bridge) object(value reflect.Value) *sobek.Object {
	key, cacheable := identity(value)
	if cacheable {
		if object, ok := b.cached(key); ok {
			return object
		}
	}
	object := b.rt.NewObject()
	if err := object.SetPrototype(b.prototype(value.Type())); err != nil {
		panic(b.typeError("set prototype: %v", err))
	}
	b.remember(object, value, key, cacheable)
	return object
}

// typeName is the $type of a wrapped value: its type's name without pointers
// or package, as "Ident", matching the declarations.
func typeName(t reflect.Type) string {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t.Name() == "" {
		return t.String()
	}
	return t.Name()
}

// methodType is the type whose methods a wrapper exposes. Struct values are
// copied to the heap for calls, so they get their pointer's methods.
func methodType(t reflect.Type) reflect.Type {
	if t.Kind() == reflect.Struct {
		return reflect.PointerTo(t)
	}
	return t
}

func (b *bridge) prototype(t reflect.Type) *sobek.Object {
	receiver := methodType(t)
	if prototype, ok := b.prototypes[receiver]; ok {
		return prototype
	}
	prototype := b.rt.NewObject()
	b.define(prototype, "$type", b.rt.ToValue(typeName(t)))
	members := map[string]bool{}
	for i := range receiver.NumMethod() {
		method := receiver.Method(i)
		name := naming.Member(method.Name)
		members[name] = true
		function := b.method(receiver, i, b.tuples[receiver.String()+"."+method.Name])
		b.define(prototype, name, function)
		if method.Name == "String" && method.Type.NumIn() == 1 && method.Type.NumOut() == 1 && method.Type.Out(0).Kind() == reflect.String {
			b.define(prototype, "toString", function)
		}
	}
	if structure, ok := structOf(t); ok {
		for _, field := range reflect.VisibleFields(structure) {
			name := naming.Member(field.Name)
			if !field.IsExported() || members[name] {
				continue
			}
			members[name] = true
			b.accessor(prototype, name, b.fieldGetter(field.Index))
		}
	}
	for name, function := range b.extensions[receiver] {
		b.accessor(prototype, name, b.boundGetter(name, function))
	}
	// Error types that are slices or arrays expose their elements, as their
	// declarations say.
	if classes, ok := b.errorClasses.Get(); ok && classes.isErrorType(t) && (t.Kind() == reflect.Slice || t.Kind() == reflect.Array) {
		b.elements(prototype)
	}
	// Go errors are GoErrors, and their message is Error().
	if classes, ok := b.errorClasses.Get(); ok && receiver.Implements(errorType()) {
		if err := prototype.SetPrototype(classes.errorPrototype()); err != nil {
			panic(b.typeError("set error prototype: %v", err))
		}
		b.accessor(prototype, "message", func(call sobek.FunctionCall) sobek.Value {
			err, _ := b.errorOf(call.This)
			return b.rt.ToValue(err.Error())
		})
	}
	b.prototypes[receiver] = prototype
	return prototype
}

func structOf(t reflect.Type) (reflect.Type, bool) {
	if t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return t, t.Kind() == reflect.Struct
}

func (b *bridge) define(object *sobek.Object, name string, value sobek.Value) {
	if err := object.DefineDataProperty(name, value, sobek.FLAG_FALSE, sobek.FLAG_FALSE, sobek.FLAG_FALSE); err != nil {
		panic(b.typeError("define %s: %v", name, err))
	}
}

func (b *bridge) accessor(object *sobek.Object, name string, getter func(sobek.FunctionCall) sobek.Value) {
	if err := object.DefineAccessorProperty(name, b.rt.ToValue(getter), nil, sobek.FLAG_FALSE, sobek.FLAG_TRUE); err != nil {
		panic(b.typeError("define %s: %v", name, err))
	}
}

// elements gives a prototype for a slice or array type length, at, and
// iteration.
func (b *bridge) elements(prototype *sobek.Object) {
	b.accessor(prototype, "length", func(call sobek.FunctionCall) sobek.Value {
		return b.rt.ToValue(b.receiverValue(call.This).Len())
	})
	b.define(prototype, "at", b.rt.ToValue(func(call sobek.FunctionCall) sobek.Value {
		value := b.receiverValue(call.This)
		index := int(call.Argument(0).ToInteger())
		if index < 0 {
			index += value.Len()
		}
		if index < 0 || index >= value.Len() {
			return sobek.Undefined()
		}
		return b.wrap(value.Index(index))
	}))
	iterate := b.rt.ToValue(func(call sobek.FunctionCall) sobek.Value {
		array := b.array(b.receiverValue(call.This)).ToObject(b.rt)
		iterator, ok := sobek.AssertFunction(array.GetSymbol(sobek.SymIterator))
		if !ok {
			panic(b.typeError("arrays are not iterable"))
		}
		result, err := iterator(array)
		if err != nil {
			panic(err)
		}
		return result
	})
	if err := prototype.DefineDataPropertySymbol(sobek.SymIterator, iterate, sobek.FLAG_FALSE, sobek.FLAG_FALSE, sobek.FLAG_FALSE); err != nil {
		panic(b.typeError("define iterator: %v", err))
	}
}

func (b *bridge) fieldGetter(index []int) func(sobek.FunctionCall) sobek.Value {
	return func(call sobek.FunctionCall) sobek.Value {
		value := b.receiverValue(call.This)
		if value.Kind() == reflect.Pointer {
			value = value.Elem()
		}
		field, err := value.FieldByIndexErr(index)
		if err != nil {
			return sobek.Null() // A nil embedded pointer hides its fields.
		}
		return b.wrap(field)
	}
}

func (b *bridge) receiverValue(this sobek.Value) reflect.Value {
	if object, isObject := this.(*sobek.Object); isObject {
		if value, ok := b.lookup(object); ok {
			return value
		}
	}
	panic(b.typeError("receiver is not a Go value"))
}

// receiver returns the value a method of receiverType is called on, copying
// struct values so pointer methods can be called.
func (b *bridge) receiver(this sobek.Value, receiverType reflect.Type) reflect.Value {
	value := b.receiverValue(this)
	if value.Type() == receiverType {
		return value
	}
	if receiverType.Kind() == reflect.Pointer && value.Type() == receiverType.Elem() {
		pointer := reflect.New(value.Type())
		pointer.Elem().Set(value)
		return pointer
	}
	panic(b.typeError("receiver is %s, not %s", value.Type(), receiverType))
}

func (b *bridge) method(receiverType reflect.Type, index int, tuple bool) sobek.Value {
	return b.rt.ToValue(func(call sobek.FunctionCall) sobek.Value {
		return b.call(b.receiver(call.This, receiverType).Method(index), nil, call.Arguments, tuple)
	})
}

// function wraps a Go function. It is also a native predicate when it takes
// one argument and returns bool.
func (b *bridge) function(function reflect.Value, tuple bool) *sobek.Object {
	object := b.rt.ToValue(func(call sobek.FunctionCall) sobek.Value {
		return b.call(function, nil, call.Arguments, tuple)
	}).ToObject(b.rt)
	if predicate, ok := funcNative(function, nil); ok {
		b.current.natives[object] = predicate
	}
	return object
}

// call converts arguments, calls a Go function after any bound arguments, and
// converts its results.
func (b *bridge) call(function reflect.Value, bound []reflect.Value, arguments []sobek.Value, tuple bool) sobek.Value {
	in, err := b.arguments(function.Type(), bound, arguments)
	if err != nil {
		panic(b.typeError("%v", err))
	}
	out, err := invoke(function, in)
	if err != nil {
		panic(b.goError(err))
	}
	return b.results(function.Type(), out, tuple)
}

// invoke turns a Go panic into an error. Exceptions thrown by JavaScript
// callbacks pass through so sobek rethrows them unchanged.
func invoke(function reflect.Value, in []reflect.Value) (out []reflect.Value, err error) {
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		switch recovered.(type) {
		case *sobek.Exception, *sobek.InterruptedError, *sobek.Object:
			panic(recovered)
		}
		err = errors.Errorf("go panic: %v", recovered)
	}()
	return function.Call(in), nil
}

func (b *bridge) arguments(t reflect.Type, bound []reflect.Value, arguments []sobek.Value) ([]reflect.Value, error) {
	in := append([]reflect.Value{}, bound...)
	fixed := t.NumIn()
	if t.IsVariadic() {
		fixed--
	}
	for i := len(bound); i < fixed; i++ {
		argument := sobek.Undefined()
		if j := i - len(bound); j < len(arguments) {
			argument = arguments[j]
		}
		value, err := b.unwrap(argument, t.In(i))
		if err != nil {
			return nil, errors.Errorf("argument %d: %v", i-len(bound), err)
		}
		in = append(in, value)
	}
	if !t.IsVariadic() {
		return in, nil
	}
	element := t.In(fixed).Elem()
	for j := fixed - len(bound); j < len(arguments); j++ {
		value, err := b.unwrap(arguments[j], element)
		if err != nil {
			return nil, errors.Errorf("argument %d: %v", j, err)
		}
		in = append(in, value)
	}
	return in, nil
}

func (b *bridge) results(t reflect.Type, out []reflect.Value, tuple bool) sobek.Value {
	if n := len(out); n > 0 && t.Out(n-1) == errorType() {
		if !out[n-1].IsNil() {
			err, _ := reflect.TypeAssert[error](out[n-1])
			panic(b.goError(err))
		}
		out = out[:n-1]
	}
	switch {
	case len(out) == 0:
		return sobek.Undefined()
	case len(out) == 1:
		return b.wrap(out[0])
	case len(out) == 2 && out[1].Type() == reflect.TypeFor[bool]() && !tuple:
		if !out[1].Bool() {
			return sobek.Undefined()
		}
		return b.wrap(out[0])
	}
	items := make([]any, len(out))
	for i, value := range out {
		items[i] = b.wrap(value)
	}
	return b.rt.NewArray(items...)
}

func isBasic(kind reflect.Kind) bool {
	return kind >= reflect.Bool && kind <= reflect.Complex128 || kind == reflect.String
}

func errorType() reflect.Type {
	return reflect.TypeFor[error]()
}

func nillable(t reflect.Type) bool {
	switch t.Kind() { //nolint:exhaustive // Other kinds have no nil.
	case reflect.Pointer, reflect.Interface, reflect.Map, reflect.Slice, reflect.Func, reflect.Chan, reflect.UnsafePointer:
		return true
	}
	return false
}

// unwrap converts a JavaScript value to a Go value of type t.
func (b *bridge) unwrap(value sobek.Value, t reflect.Type) (reflect.Value, error) {
	if isAbsent(value) {
		if nillable(t) {
			return reflect.Zero(t), nil
		}
		return reflect.Value{}, errors.Errorf("expected %s, got null", t)
	}
	if object, ok := value.(*sobek.Object); ok {
		return b.unwrapObject(object, t)
	}
	exported := value.Export()
	switch t.Kind() { //nolint:exhaustive // Other kinds have no primitive form.
	case reflect.String:
		if text, ok := exported.(string); ok {
			return reflect.ValueOf(text).Convert(t), nil
		}
	case reflect.Bool:
		if flag, ok := exported.(bool); ok {
			return reflect.ValueOf(flag).Convert(t), nil
		}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr,
		reflect.Float32, reflect.Float64:
		return number(exported, t)
	case reflect.Slice:
		if text, ok := exported.(string); ok && t.Elem().Kind() == reflect.Uint8 {
			return reflect.ValueOf([]byte(text)).Convert(t), nil
		}
	case reflect.Interface:
		if converted := reflect.ValueOf(exported); converted.IsValid() && converted.Type().AssignableTo(t) {
			return converted, nil
		}
	}
	return reflect.Value{}, errors.Errorf("expected %s, got %s", t, value.ExportType())
}

func number(exported any, t reflect.Type) (reflect.Value, error) {
	var value reflect.Value
	switch exported := exported.(type) {
	case int64:
		value = reflect.ValueOf(exported)
	case float64:
		if t.Kind() != reflect.Float32 && t.Kind() != reflect.Float64 && exported != float64(int64(exported)) {
			return reflect.Value{}, errors.Errorf("expected an integer for %s, got %v", t, exported)
		}
		value = reflect.ValueOf(exported)
	default:
		return reflect.Value{}, errors.Errorf("expected a number for %s", t)
	}
	return value.Convert(t), nil
}

func (b *bridge) unwrapObject(object *sobek.Object, t reflect.Type) (reflect.Value, error) {
	if token, ok := b.tokens[object]; ok {
		typedNil := reflect.Zero(token)
		if !token.AssignableTo(t) {
			return reflect.Value{}, errors.Errorf("type token %s is not a %s", typeName(token), t)
		}
		return typedNil, nil
	}
	// A caught exception passes the error it was thrown for, not the typed
	// error in its wrap chain that it exposes.
	if err, ok := b.thrownError(object); ok && t == errorType() {
		return reflect.ValueOf(&err).Elem(), nil
	}
	if value, ok := b.lookup(object); ok {
		return adapt(value, t)
	}
	switch t.Kind() { //nolint:exhaustive // Other kinds cannot come from plain objects.
	case reflect.Func:
		return b.callback(object, t)
	case reflect.Slice, reflect.Array:
		return b.unwrapArray(object, t)
	}
	return reflect.Value{}, errors.Errorf("expected %s, got a JavaScript object", t)
}

// adapt converts between a value and its pointer when the other is wanted.
func adapt(value reflect.Value, t reflect.Type) (reflect.Value, error) {
	switch {
	case value.Type().AssignableTo(t):
		return value, nil
	case value.Kind() == reflect.Pointer && value.Elem().Type().AssignableTo(t):
		return value.Elem(), nil
	case t.Kind() == reflect.Pointer && value.Type().AssignableTo(t.Elem()):
		pointer := reflect.New(value.Type())
		pointer.Elem().Set(value)
		return pointer, nil
	}
	return reflect.Value{}, errors.Errorf("expected %s, got %s", t, value.Type())
}

func (b *bridge) unwrapArray(object *sobek.Object, t reflect.Type) (reflect.Value, error) {
	length := int(object.Get("length").ToInteger())
	var result reflect.Value
	if t.Kind() == reflect.Array {
		if length != t.Len() {
			return reflect.Value{}, errors.Errorf("expected %d elements, got %d", t.Len(), length)
		}
		result = reflect.New(t).Elem()
	} else {
		result = reflect.MakeSlice(t, length, length)
	}
	for i := range length {
		element, err := b.unwrap(object.Get(strconv.Itoa(i)), t.Elem())
		if err != nil {
			return reflect.Value{}, errors.Errorf("element %d: %v", i, err)
		}
		result.Index(i).Set(element)
	}
	return result, nil
}

// callback wraps a JavaScript function as a Go function. A wrapped Go
// function of the right type is passed through unwrapped.
func (b *bridge) callback(object *sobek.Object, t reflect.Type) (reflect.Value, error) {
	function, ok := sobek.AssertFunction(object)
	if !ok {
		return reflect.Value{}, errors.Errorf("expected a function for %s", t)
	}
	return reflect.MakeFunc(t, func(args []reflect.Value) []reflect.Value {
		arguments := make([]sobek.Value, len(args))
		for i, arg := range args {
			arguments[i] = b.wrap(arg)
		}
		result, err := function(sobek.Undefined(), arguments...)
		if err != nil {
			panic(err) // Rethrown to the script by invoke's caller.
		}
		return b.callbackResults(t, result)
	}), nil
}

func (b *bridge) callbackResults(t reflect.Type, result sobek.Value) []reflect.Value {
	switch t.NumOut() {
	case 0:
		return nil
	case 1:
		value, err := b.unwrap(result, t.Out(0))
		if err != nil {
			panic(b.typeError("callback result: %v", err))
		}
		return []reflect.Value{value}
	}
	object, ok := result.(*sobek.Object)
	if !ok {
		panic(b.typeError("callback must return an array of %d values", t.NumOut()))
	}
	out := make([]reflect.Value, t.NumOut())
	for i := range out {
		value, err := b.unwrap(object.Get(strconv.Itoa(i)), t.Out(i))
		if err != nil {
			panic(b.typeError("callback result %d: %v", i, err))
		}
		out[i] = value
	}
	return out
}

// isSequence reports whether t is an iter.Seq or iter.Seq2 instantiation.
func isSequence(t reflect.Type) bool {
	return t.PkgPath() == "iter" && (strings.HasPrefix(t.Name(), "Seq[") || strings.HasPrefix(t.Name(), "Seq2["))
}

// mapView wraps a Go map as a read-only view. Keys are converted to the map's
// key type, so wrapped Go values look up by Go identity.
func (b *bridge) mapView(value reflect.Value) sobek.Value {
	key, _ := identity(value)
	if object, ok := b.cached(key); ok {
		return object
	}
	object := b.rt.NewObject()
	if err := object.SetPrototype(b.mapProto); err != nil {
		panic(b.typeError("set prototype: %v", err))
	}
	b.remember(object, value, key, true)
	return object
}

func (b *bridge) newMapPrototype() *sobek.Object {
	prototype := b.rt.NewObject()
	b.define(prototype, "$type", b.rt.ToValue("MapView"))
	b.define(prototype, "get", b.rt.ToValue(func(call sobek.FunctionCall) sobek.Value {
		element, ok := b.mapIndex(call)
		if !ok {
			return sobek.Undefined()
		}
		return b.wrap(element)
	}))
	b.define(prototype, "has", b.rt.ToValue(func(call sobek.FunctionCall) sobek.Value {
		_, ok := b.mapIndex(call)
		return b.rt.ToValue(ok)
	}))
	b.define(prototype, "keys", b.rt.ToValue(func(call sobek.FunctionCall) sobek.Value {
		return b.mapItems(call.This, func(key, _ reflect.Value) any { return b.wrap(key) })
	}))
	b.define(prototype, "values", b.rt.ToValue(func(call sobek.FunctionCall) sobek.Value {
		return b.mapItems(call.This, func(_, value reflect.Value) any { return b.wrap(value) })
	}))
	entries := func(call sobek.FunctionCall) sobek.Value {
		return b.mapItems(call.This, func(key, value reflect.Value) any { return b.rt.NewArray(b.wrap(key), b.wrap(value)) })
	}
	b.define(prototype, "entries", b.rt.ToValue(entries))
	b.accessor(prototype, "size", func(call sobek.FunctionCall) sobek.Value {
		return b.rt.ToValue(b.receiverValue(call.This).Len())
	})
	iterate := b.rt.ToValue(func(call sobek.FunctionCall) sobek.Value {
		array := entries(call).ToObject(b.rt)
		iterator, ok := sobek.AssertFunction(array.GetSymbol(sobek.SymIterator))
		if !ok {
			panic(b.typeError("arrays are not iterable"))
		}
		result, err := iterator(array)
		if err != nil {
			panic(err)
		}
		return result
	})
	if err := prototype.DefineDataPropertySymbol(sobek.SymIterator, iterate, sobek.FLAG_FALSE, sobek.FLAG_FALSE, sobek.FLAG_FALSE); err != nil {
		panic(b.typeError("define iterator: %v", err))
	}
	return prototype
}

// mapIndex looks up the call's first argument. A key that cannot convert to
// the key type is absent rather than an error.
func (b *bridge) mapIndex(call sobek.FunctionCall) (reflect.Value, bool) {
	m := b.receiverValue(call.This)
	key, err := b.unwrap(call.Argument(0), m.Type().Key())
	if err != nil {
		return reflect.Value{}, false
	}
	element := m.MapIndex(key)
	return element, element.IsValid()
}

func (b *bridge) mapItems(this sobek.Value, item func(key, value reflect.Value) any) sobek.Value {
	m := b.receiverValue(this)
	items := make([]any, 0, m.Len())
	iterator := m.MapRange()
	for iterator.Next() {
		items = append(items, item(iterator.Key(), iterator.Value()))
	}
	return b.rt.NewArray(items...)
}

func (b *bridge) sequence(seq reflect.Value) sobek.Value {
	return b.iterable(newSequence(seq))
}

// iterable hands a sequence's native handle to the prelude's GoIterable.
func (b *bridge) iterable(s *sequence) sobek.Value {
	if b.iterableFactory == nil {
		panic(b.typeError("the tsk module has not been evaluated"))
	}
	result, err := b.iterableFactory(sobek.Undefined(), b.handle(s))
	if err != nil {
		panic(err)
	}
	return result
}

// handle is the native side of a GoIterable. Its filter returns another
// handle, or null when the predicate must run in JavaScript.
func (b *bridge) handle(s *sequence) *sobek.Object {
	handle := b.rt.NewObject()
	b.define(handle, "open", b.rt.ToValue(func(sobek.FunctionCall) sobek.Value {
		return b.open(s)
	}))
	b.define(handle, "filter", b.rt.ToValue(func(call sobek.FunctionCall) sobek.Value {
		filter, ok := b.predicate(call.Argument(0), s.elementType())
		if !ok || s.isPair() {
			return sobek.Null()
		}
		return b.handle(s.filtered(filter))
	}))
	return handle
}

// open starts pulling a sequence. The pass stops it if the script does not.
func (b *bridge) open(s *sequence) sobek.Value {
	next, stop := s.pull()
	b.current.stops = append(b.current.stops, stop)
	cursor := b.rt.NewObject()
	b.define(cursor, "pull", b.rt.ToValue(func(call sobek.FunctionCall) sobek.Value {
		limit := min(max(int(call.Argument(0).ToInteger()), 1), batchLimit)
		items, err := b.pull(s, next, limit)
		if err != nil {
			panic(b.goError(err))
		}
		return b.rt.NewArray(items...)
	}))
	b.define(cursor, "stop", b.rt.ToValue(func(sobek.FunctionCall) sobek.Value {
		stop()
		return sobek.Undefined()
	}))
	return cursor
}

// pull wraps up to limit elements that pass every filter.
func (b *bridge) pull(s *sequence, next func() (step, bool), limit int) ([]any, error) {
	steps, err := s.take(next, limit)
	if err != nil {
		return nil, err
	}
	items := make([]any, len(steps))
	for i, current := range steps {
		if s.isPair() {
			items[i] = b.rt.NewArray(b.wrap(current.first), b.wrap(current.second))
		} else {
			items[i] = b.wrap(current.first)
		}
	}
	return items, nil
}

func (b *bridge) native(object *sobek.Object) (native, bool) {
	if found, ok := b.current.natives[object]; ok {
		return found, true
	}
	found, ok := b.global.natives[object]
	return found, ok
}

// predicate returns the Go test for a native predicate value.
func (b *bridge) predicate(value sobek.Value, element reflect.Type) (func(reflect.Value) bool, bool) {
	object, ok := value.(*sobek.Object)
	if !ok {
		return nil, false
	}
	found, ok := b.native(object)
	if !ok {
		return nil, false
	}
	return found.test(element)
}

// combine builds and, or, and not over native predicates. It returns null if
// any operand is a JavaScript function, so the prelude combines in JavaScript.
func (b *bridge) combine(operator string, operands []sobek.Value) sobek.Value {
	natives := make([]native, len(operands))
	callables := make([]sobek.Callable, len(operands))
	for i, operand := range operands {
		object, ok := operand.(*sobek.Object)
		if !ok {
			return sobek.Null()
		}
		found, ok := b.native(object)
		callable, callableOK := sobek.AssertFunction(object)
		if !ok || !callableOK {
			return sobek.Null()
		}
		natives[i], callables[i] = found, callable
	}
	object := b.rt.ToValue(func(call sobek.FunctionCall) sobek.Value {
		return b.rt.ToValue(evaluate(operator, len(callables), func(i int) bool {
			result, err := callables[i](sobek.Undefined(), call.Arguments...)
			if err != nil {
				panic(err)
			}
			return result.ToBoolean()
		}))
	}).ToObject(b.rt)
	b.current.natives[object] = native{test: func(element reflect.Type) (func(reflect.Value) bool, bool) {
		tests := make([]func(reflect.Value) bool, len(natives))
		for i, operand := range natives {
			test, ok := operand.test(element)
			if !ok {
				return nil, false
			}
			tests[i] = test
		}
		return func(value reflect.Value) bool {
			return evaluate(operator, len(tests), func(i int) bool { return tests[i](value) })
		}, true
	}}
	return object
}

// boundGetter exposes an extension function as a property holding a native
// function bound to the receiver, so it can be passed to filter.
func (b *bridge) boundGetter(name string, function reflect.Value) func(sobek.FunctionCall) sobek.Value {
	return func(call sobek.FunctionCall) sobek.Value {
		receiver, isObject := call.This.(*sobek.Object)
		if !isObject {
			panic(b.typeError("%s needs a receiver", name))
		}
		key := boundKey{receiver: receiver, name: name}
		if cached, ok := b.current.bound[key]; ok {
			return cached
		}
		bound := []reflect.Value{b.receiverValue(receiver)}
		object := b.rt.ToValue(func(inner sobek.FunctionCall) sobek.Value {
			return b.call(function, bound, inner.Arguments, false)
		}).ToObject(b.rt)
		if predicate, ok := funcNative(function, bound); ok {
			b.current.natives[object] = predicate
		}
		b.current.bound[key] = object
		return object
	}
}
