package user

import "decl"

func first(value decl.First) {
	switch value.(type) { // want `sum type "First" \(from .*decl.go:4:6\): missing cases for FirstB$`
	case *decl.FirstA:
	}
}

func hidden() {
	switch decl.Hidden().(type) { // want `sum type "hidden" .*missing cases for HiddenA$`
	case *decl.HiddenB:
	}
}
