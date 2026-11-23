package configureduser

import "configured"

func node(n configured.Node) {
	switch n.(type) { // want `sum type "Node" \(from .*configured.go:3:6\): missing cases for B$`
	case *configured.A:
	}
}
