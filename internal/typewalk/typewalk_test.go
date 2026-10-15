package typewalk_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"testing"

	"github.com/alecthomas/assert/v2"

	"github.com/alecthomas/tsk/internal/typewalk"
)

func TestWalk(t *testing.T) {
	declare := func(types.Type) typewalk.Action { return typewalk.Declaration }
	components := func(types.Type) typewalk.Action { return typewalk.Components }
	tests := []struct {
		name         string
		source       string
		object       string
		exportedOnly bool
		visit        func(t types.Type) typewalk.Action
		expected     []string
	}{
		{
			name:     "SelfReferentialNamed",
			source:   "type node struct{ next *node }",
			object:   "node",
			visit:    declare,
			expected: []string{"node", "struct{next *node}", "*node", "node"},
		},
		{
			name:   "RecursiveConstraint",
			source: "type S[T interface{ ~[]T }] []T",
			object: "S",
			visit:  declare,
			expected: []string{
				"S[T interface{~[]T}]", "T", "interface{~[]T}", "~[]T", "[]T", "T",
				"[]T", "T",
			},
		},
		{
			name: "Components",
			source: "type A[K comparable] = map[K]chan int\n" +
				"type L[T any] []T\n" +
				"var V func(A[string], ...error) ([2]*byte, interface{ M(); stringer }, L[bool])\n" +
				"type stringer interface{ String() string }",
			object: "V",
			visit:  components,
			expected: []string{
				"func(A[string], ...error) ([2]*byte, interface{M(); stringer}, L[bool])",
				"A[string]", "string", "map[string]chan int", "string", "chan int", "int",
				"[]error", "error",
				"[2]*byte", "*byte", "byte",
				"interface{M(); stringer}", "func()", "stringer",
				"L[bool]", "bool",
			},
		},
		{
			name:   "Skip",
			source: "type T struct{ a map[string][]int; b *bool }",
			object: "T",
			visit: func(t types.Type) typewalk.Action {
				if _, ok := t.(*types.Map); ok {
					return typewalk.Skip
				}
				return typewalk.Declaration
			},
			expected: []string{"T", "struct{a map[string][]int; b *bool}", "map[string][]int", "*bool", "bool"},
		},
		{
			name: "ExportedOnly",
			source: "type T struct{ A int; b string; e }\n" +
				"type e struct{ C float32 }\n" +
				"func (T) M(x int8) {}\n" +
				"func (T) m(y int16) {}",
			object:       "T",
			exportedOnly: true,
			visit:        declare,
			expected: []string{
				"T", "struct{A int; b string; e}", "int", "e", "struct{C float32}", "float32",
				"func(x int8)", "int8",
			},
		},
		{
			name:         "ExportedOnlyInterface",
			source:       "type I interface{ N(); n(z int32) }",
			object:       "I",
			exportedOnly: true,
			visit:        declare,
			expected:     []string{"I", "interface{N(); n(z int32)}", "func()"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			pkg := check(t, test.source)
			var visited []string
			typewalk.Walk(pkg.Scope().Lookup(test.object).Type(), test.exportedOnly, func(t types.Type) typewalk.Action {
				visited = append(visited, types.TypeString(t, types.RelativeTo(pkg)))
				return test.visit(t)
			})
			assert.Equal(t, test.expected, visited)
		})
	}
}

func check(t *testing.T, source string) *types.Package {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "p.go", "package p\n"+source, 0)
	assert.NoError(t, err)
	pkg, err := (&types.Config{}).Check("p", fset, []*ast.File{file}, nil)
	assert.NoError(t, err)
	return pkg
}
