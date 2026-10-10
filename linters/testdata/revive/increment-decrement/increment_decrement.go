// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package pkg ...
package pkg

func addOne(x int) int {
	x += 1 // want `^increment-decrement: should replace x \+= 1 with x\+\+$`
	return x
}

func subOneInLoop(y int) {
	for ; y > 0; y -= 1 { // want `^increment-decrement: should replace y -= 1 with y--$`
	}
}

func notOne(z []int) {
	z[0] += 2
	z[0] *= 1
	z[0] += 0x1
	z[len(z)-1] += 1 // want `^increment-decrement: should replace z\[len\(z\)-1\] \+= 1 with z\[len\(z\)-1\]\+\+$`
}
