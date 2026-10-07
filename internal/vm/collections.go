package vm

import (
	"go/ast"
	"go/types"
	"iter"
	"reflect"

	"github.com/alecthomas/errors"
	"golang.org/x/tools/go/ast/inspector"
)

// batchLimit caps how many elements one pull may return.
const batchLimit = 4096

// sequence is a Go iter.Seq or iter.Seq2 and the native filters applied to it.
type sequence struct {
	seq     reflect.Value
	element reflect.Type
	pair    bool
	filters []func(reflect.Value) bool
}

func newSequence(seq reflect.Value) *sequence {
	yield := seq.Type().In(0)
	return &sequence{seq: seq, element: yield.In(0), pair: yield.NumIn() == 2}
}

// filtered returns a copy that also applies filter. The receiver is shared by
// other iterables, so it is not modified.
func (s *sequence) filtered(filter func(reflect.Value) bool) *sequence {
	copied := *s
	copied.filters = append(append([]func(reflect.Value) bool{}, s.filters...), filter)
	return &copied
}

// elementType is the type of the first value each step yields.
func (s *sequence) elementType() reflect.Type {
	return s.element
}

// isPair reports whether the sequence is an iter.Seq2.
func (s *sequence) isPair() bool {
	return s.pair
}

// take returns up to limit steps that pass every filter. A panic in the Go
// sequence or a filter becomes an error.
func (s *sequence) take(next func() (step, bool), limit int) (steps []step, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = errors.Errorf("go panic: %v", recovered)
		}
	}()
	for len(steps) < limit {
		current, ok := next()
		if !ok {
			break
		}
		if s.accepts(current.first) {
			steps = append(steps, current)
		}
	}
	return steps, nil
}

func (s *sequence) accepts(value reflect.Value) bool {
	for _, filter := range s.filters {
		if !filter(value) {
			return false
		}
	}
	return true
}

// step is one element of a sequence: its value, and its second value for an
// iter.Seq2.
type step struct {
	first  reflect.Value
	second reflect.Value
}

// pull starts the sequence. Cursor sequences, which inspector traversals
// return, are pulled directly; others go through reflection, which costs a
// reflective call per element.
func (s *sequence) pull() (func() (step, bool), func()) {
	if cursors, isCursors := reflect.TypeAssert[iter.Seq[inspector.Cursor]](s.seq); isCursors {
		next, stop := iter.Pull(cursors)
		return func() (step, bool) {
			cursor, ok := next()
			return step{first: reflect.ValueOf(cursor)}, ok
		}, stop
	}
	results := [2][]reflect.Value{{reflect.ValueOf(false)}, {reflect.ValueOf(true)}}
	return iter.Pull(func(yield func(step) bool) {
		function := reflect.MakeFunc(s.seq.Type().In(0), func(args []reflect.Value) []reflect.Value {
			current := step{first: args[0]}
			if len(args) > 1 {
				current.second = args[1]
			}
			if yield(current) {
				return results[1]
			}
			return results[0]
		})
		s.seq.Call([]reflect.Value{function})
	})
}

// native is a Go-implemented predicate. It builds a test for elements of a
// sequence, or reports that it cannot accept them.
type native struct {
	test func(element reflect.Type) (func(reflect.Value) bool, bool)
}

// funcNative makes a Go function a predicate when, after bound arguments, it
// takes one argument and returns only bool.
func funcNative(function reflect.Value, bound []reflect.Value) (native, bool) {
	t := function.Type()
	if t.IsVariadic() || t.NumIn() != len(bound)+1 || t.NumOut() != 1 || t.Out(0) != reflect.TypeFor[bool]() {
		return native{}, false
	}
	parameter := t.In(len(bound))
	return native{test: func(reflect.Type) (func(reflect.Value) bool, bool) {
		in := append(append([]reflect.Value{}, bound...), reflect.Value{})
		return func(value reflect.Value) bool {
			argument, ok := adaptElement(value, parameter)
			if !ok {
				return false
			}
			in[len(in)-1] = argument
			return function.Call(in)[0].Bool()
		}, true
	}}, true
}

// adaptElement fits a sequence element to a predicate's parameter. Cursors
// stand for their nodes, so node predicates filter cursor sequences.
func adaptElement(value reflect.Value, parameter reflect.Type) (reflect.Value, bool) {
	if cursor, ok := reflect.TypeAssert[inspector.Cursor](value); ok && parameter != value.Type() {
		node := cursor.Node()
		value = reflect.ValueOf(&node).Elem()
	}
	if value.Type().AssignableTo(parameter) {
		return value, true
	}
	if value.Kind() == reflect.Interface && !value.IsNil() && value.Elem().Type().AssignableTo(parameter) {
		return value.Elem(), true
	}
	return reflect.Value{}, false
}

func evaluate(operator string, n int, operand func(int) bool) bool {
	switch operator {
	case "and":
		for i := range n {
			if !operand(i) {
				return false
			}
		}
		return true
	case "or":
		for i := range n {
			if operand(i) {
				return true
			}
		}
		return false
	}
	return n == 1 && !operand(0)
}

// extensions are host methods added to Go types, keyed by receiver type. Each
// takes the receiver first.
func extensions() map[reflect.Type]map[string]reflect.Value {
	return map[reflect.Type]map[string]reflect.Value{
		reflect.TypeFor[*types.Info](): {
			"isNil":  reflect.ValueOf(infoIsNil),
			"isType": reflect.ValueOf(infoIsType),
		},
	}
}

func infoIsNil(info *types.Info, node ast.Node) bool {
	expr, ok := node.(ast.Expr)
	return ok && info.Types[expr].IsNil()
}

func infoIsType(info *types.Info, node ast.Node) bool {
	expr, ok := node.(ast.Expr)
	return ok && info.Types[expr].IsType()
}
