package p

import "context"

func short() int {
	x := 1 // want `^variable name 'x' is too short for the scope of its usage$`
	x++
	x++
	x++
	x++
	x++
	return x
}

func near() int {
	x := 1
	return x
}

func param(n int) int { // want `^parameter name 'n' is too short for the scope of its usage$`
	total := 0
	total++
	total++
	total++
	total++
	total++
	return total + n
}

func conventional(ctx context.Context) error {
	_ = 1
	_ = 2
	_ = 3
	_ = 4
	_ = 5
	return ctx.Err()
}
