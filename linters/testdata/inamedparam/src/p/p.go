package p

import "context"

type Named interface {
	Do(ctx context.Context, n int) error
}

type Unnamed interface {
	Do(context.Context, int) error // want `^interface method Do must have named param for type context.Context$` `^interface method Do must have named param for type int$`
	Each(func()) // want `^interface method Each must have all named params$`
}
