package expmixed

import (
	"golang.org/x/exp/constraints"
	"golang.org/x/exp/slices"
)

// Chunked has no replacement, so the import stays and each call is reported.
func use(s []int) {
	_ = slices.Contains(s, 1) // want `^golang.org/x/exp/slices.Contains\(\) can be replaced by slices.Contains\(\)$`
	_ = slices.Chunked(s, 2)
}

func largest[T constraints.Ordered](a, b T) T { // want `^golang.org/x/exp/constraints.Ordered can be replaced by cmp.Ordered$`
	return a
}

type number interface {
	constraints.Integer | ~float64
}
