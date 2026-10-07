package nodes

type node interface{ Visit() }

type disjunction struct{ nodes []node }

func (*disjunction) Visit() {}

type strct struct{ expr node }

func (*strct) Visit() {}

type unrelated struct{ hidden int }

func (*unrelated) Touch() {}

func visit(n node, other *unrelated) {
	continueVisit := func() {
		switch n := n.(type) {
		case *disjunction:
			_ = n.nodes
		case *strct:
			n.expr = n.expr
		}
		_ = other.hidden // want "private field example/nodes.unrelated.hidden may only be accessed"
	}
	continueVisit()
}

func validate(n node) {
	if n, ok := n.(*disjunction); ok {
		_ = n.nodes // want "private field example/nodes.disjunction.nodes may only be accessed"
	}
}
