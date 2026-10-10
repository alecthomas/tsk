// Adapted from github.com/mgechev/revive's tests, MIT License.

package uselessbreak

import (
	"fmt"
	ast "go/ast"
	"reflect"
)

var (
	c, n    chan int
	c1      bool
	desc    struct{ Args []ast.Expr }
	found   bool
	funcLit *ast.FuncLit
	val     reflect.Value
	s       state
)

type state struct{}

func (state) errorf(string, ...any) {}

func oneIteration(reflect.Value, reflect.Value) {}

func sortMap(reflect.Value) struct{ Key, Value []reflect.Value } {
	return struct{ Key, Value []reflect.Value }{}
}

func UselessBreaks() {

	switch {
	case true:
		break // want `^useless-break: useless break in case clause$`
	case false:
		if false {
			break
		}
	}

	select {
	case <-c:
		break // want `^useless-break: useless break in case clause$`
	case <-n:
		if true {
			if false {
				break
			}
			break
		}
	}

	for {
		switch {
		case c1:
			break // want `^useless-break: useless break in case clause \(WARN: this break statement affects this switch or select statement and not the loop enclosing it\)$`
		}
	}

	for _, node := range desc.Args {
		switch node := node.(type) {
		case *ast.FuncLit:
			found = true
			funcLit = node
			break // want `^useless-break: useless break in case clause \(WARN: this break statement affects this switch or select statement and not the loop enclosing it\)$`
		}
	}

	switch val.Kind() {
	case reflect.Array, reflect.Slice:
		if val.Len() == 0 {
			break
		}
		for i := 0; i < val.Len(); i++ {
			oneIteration(reflect.ValueOf(i), val.Index(i))
		}
		return
	case reflect.Map:
		if val.Len() == 0 {
			break
		}
		om := sortMap(val)
		for i, key := range om.Key {
			oneIteration(key, om.Value[i])
		}
		return
	case reflect.Chan:
		if val.IsNil() {
			break
		}
		if val.Type().ChanDir() == reflect.SendDir {
			s.errorf("range over send-only channel %v", val)
			break
		}
		i := 0
		for ; ; i++ {
			elem, ok := val.Recv()
			if !ok {
				break
			}
			oneIteration(reflect.ValueOf(i), elem)
		}
		if i == 0 {
			break
		}
		return
	case reflect.Invalid:
		break // want `^useless-break: useless break in case clause$`
	default:
		s.errorf("range can't iterate over %v", val)
	}

	// issue #1281
	switch 1 {
	case 1:
		fmt.Println("foo")
		break // want `^useless-break: useless break in case clause$`
	case 2:
		fmt.Println("bar")
		break
		fmt.Println("baz")
	case 3:
	}
}
