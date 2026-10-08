package vm

import (
	"reflect"

	"github.com/alecthomas/errors"
	"github.com/grafana/sobek"

	"github.com/alecthomas/tsk/internal/bindings"
)

// errorClasses builds the JavaScript classes and exceptions for Go errors,
// using the prelude's GoError and helpers.
type errorClasses struct {
	prototype     *sobek.Object
	create        sobek.Callable
	sentinel      sobek.Callable
	errorType     sobek.Callable
	sentinels     map[any]*sobek.Object
	exposedErrors map[reflect.Type]bool
}

// newErrorClasses reads the prelude's error support object.
func newErrorClasses(rt *sobek.Runtime, support *sobek.Object) (*errorClasses, error) {
	classes := &errorClasses{sentinels: map[any]*sobek.Object{}, exposedErrors: exposedErrorTypes()}
	var ok [3]bool
	classes.create, ok[0] = sobek.AssertFunction(support.Get("create"))
	classes.sentinel, ok[1] = sobek.AssertFunction(support.Get("sentinel"))
	classes.errorType, ok[2] = sobek.AssertFunction(support.Get("errorType"))
	if ok != [3]bool{true, true, true} {
		return nil, errors.New("error support functions are not callable")
	}
	classes.prototype = support.Get("base").ToObject(rt).Get("prototype").ToObject(rt)
	return classes, nil
}

// exposedErrorTypes returns the types the generator declared as error
// classes, as both T and *T because either may be the dynamic type.
func exposedErrorTypes() map[reflect.Type]bool {
	exposed := map[reflect.Type]bool{}
	for _, pkg := range bindings.Packages() {
		for _, name := range pkg.ErrorTypes {
			t := pkg.Types[name]
			exposed[t] = true
			exposed[reflect.PointerTo(t)] = true
		}
	}
	return exposed
}

// typed returns the first error in err's wrap chain whose type is exposed, as
// errors.As would find it.
func (c *errorClasses) typed(err error) (reflect.Value, bool) {
	queue := []error{err}
	for len(queue) > 0 {
		next := queue[0]
		queue = queue[1:]
		if value := reflect.ValueOf(next); c.exposedErrors[value.Type()] {
			return value, true
		}
		// The walk follows both Unwrap forms itself, as errors.As does.
		switch wrapper := next.(type) { //nolint:errorlint // Each wrapper is unwrapped explicitly.
		case interface{ Unwrap() error }:
			if inner := wrapper.Unwrap(); inner != nil {
				queue = append(queue, inner)
			}
		case interface{ Unwrap() []error }:
			queue = append(queue, wrapper.Unwrap()...)
		}
	}
	return reflect.Value{}, false
}

// exception creates an Error with prototype, so it has a JavaScript stack.
func (c *errorClasses) exception(prototype *sobek.Object, message sobek.Value) (*sobek.Object, error) {
	value, err := c.create(sobek.Undefined(), prototype, message)
	if err != nil {
		return nil, errors.WithStack(err)
	}
	exception, ok := value.(*sobek.Object)
	if !ok {
		return nil, errors.New("error support created a non-object")
	}
	return exception, nil
}

// sentinelClass returns the class for an error variable. Variables shared
// between packages, such as os.ErrNotExist and fs.ErrNotExist, share a class.
func (c *errorClasses) sentinelClass(name sobek.Value, sentinel error, matches sobek.Value) (*sobek.Object, error) {
	key, cacheable := identity(reflect.ValueOf(sentinel))
	if cached, ok := c.sentinels[key]; cacheable && ok {
		return cached, nil
	}
	value, err := c.sentinel(sobek.Undefined(), name, matches)
	if err != nil {
		return nil, errors.WithStack(err)
	}
	class, ok := value.(*sobek.Object)
	if !ok {
		return nil, errors.New("error support created a non-object class")
	}
	if cacheable {
		c.sentinels[key] = class
	}
	return class, nil
}

// errorTypeClass returns a class whose prototype is an error type's Go
// prototype, so instanceof matches its values and exceptions.
func (c *errorClasses) errorTypeClass(name sobek.Value, prototype *sobek.Object) (*sobek.Object, error) {
	value, err := c.errorType(sobek.Undefined(), name, prototype)
	if err != nil {
		return nil, errors.WithStack(err)
	}
	class, ok := value.(*sobek.Object)
	if !ok {
		return nil, errors.New("error support created a non-object class")
	}
	return class, nil
}

// isErrorType reports whether t is a type declared as an error class.
func (c *errorClasses) isErrorType(t reflect.Type) bool {
	return c.exposedErrors[t]
}

// errorPrototype is GoError.prototype.
func (c *errorClasses) errorPrototype() *sobek.Object {
	return c.prototype
}
