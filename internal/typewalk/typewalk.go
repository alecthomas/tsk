// Package typewalk visits every type a go/types type mentions.
package typewalk

import "go/types"

// Action tells Walk how far to descend into a visited type.
type Action int

const (
	// Skip visits none of the type's components.
	Skip Action = iota
	// Components visits the type's components; a named type's are its type
	// arguments. A method's receiver is never visited.
	Components
	// Declaration also visits a named type's type parameters, underlying
	// type, and methods, as its generic origin declares them.
	Declaration
)

// Walk calls visit on t and on the types it mentions, depth first, walking each
// constraint and declaration once. exportedOnly skips unexported fields and methods.
func Walk(t types.Type, exportedOnly bool, visit func(t types.Type) Action) {
	newWalker(exportedOnly, visit).walk(t)
}

type walker struct {
	visit        func(t types.Type) Action
	exportedOnly bool
	constraints  map[*types.TypeParam]bool
	// declarations are keyed by origin, so every instance of a generic type
	// shares one entry.
	declarations map[*types.Named]bool
}

func newWalker(exportedOnly bool, visit func(t types.Type) Action) *walker {
	return &walker{
		visit:        visit,
		exportedOnly: exportedOnly,
		constraints:  map[*types.TypeParam]bool{},
		declarations: map[*types.Named]bool{},
	}
}

func (w *walker) walk(t types.Type) {
	action := w.visit(t)
	if action == Skip {
		return
	}
	switch t := t.(type) {
	case *types.Alias:
		w.list(t.TypeArgs())
		w.walk(t.Rhs())
	case *types.Named:
		w.list(t.TypeArgs())
		if action == Declaration {
			w.declaration(t.Origin())
		}
	case *types.Pointer:
		w.walk(t.Elem())
	case *types.Slice:
		w.walk(t.Elem())
	case *types.Array:
		w.walk(t.Elem())
	case *types.Chan:
		w.walk(t.Elem())
	case *types.Map:
		w.walk(t.Key())
		w.walk(t.Elem())
	case *types.Signature:
		w.typeParams(t.TypeParams())
		w.tuple(t.Params())
		w.tuple(t.Results())
	case *types.Tuple:
		w.tuple(t)
	case *types.Struct:
		for field := range t.Fields() {
			// An embedded field promotes its exported members, whatever its name.
			if !w.exportedOnly || field.Exported() || field.Embedded() {
				w.walk(field.Type())
			}
		}
	case *types.Interface:
		for method := range t.ExplicitMethods() {
			if !w.exportedOnly || method.Exported() {
				w.walk(method.Type())
			}
		}
		for embedded := range t.EmbeddedTypes() {
			w.walk(embedded)
		}
	case *types.Union:
		for term := range t.Terms() {
			w.walk(term.Type())
		}
	case *types.TypeParam:
		if !w.constraints[t] {
			w.constraints[t] = true
			w.walk(t.Constraint())
		}
	}
}

func (w *walker) declaration(origin *types.Named) {
	if w.declarations[origin] {
		return
	}
	w.declarations[origin] = true
	w.typeParams(origin.TypeParams())
	w.walk(origin.Underlying())
	for method := range origin.Methods() {
		if !w.exportedOnly || method.Exported() {
			w.walk(method.Type())
		}
	}
}

func (w *walker) list(list *types.TypeList) {
	for t := range list.Types() {
		w.walk(t)
	}
}

func (w *walker) typeParams(list *types.TypeParamList) {
	for param := range list.TypeParams() {
		w.walk(param)
	}
}

func (w *walker) tuple(tuple *types.Tuple) {
	for v := range tuple.Variables() {
		w.walk(v.Type())
	}
}
