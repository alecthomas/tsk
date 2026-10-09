// Adapted from wastedassign's tests, MIT License.
package p

func value() int { return 1 }

func reassigned() int {
	x := value() // want `^assigned to x, but reassigned without using the value$`
	x = 2
	return x
}

func neverUsed() int {
	x := value()
	if x > 0 {
		x = 3 // want `^assigned to x, but never used afterwards$`
	}
	return 0
}

func usedInBranch(cond bool) int {
	x := value()
	if cond {
		x = 2
	}
	return x
}

func loop() int {
	total := 0
	for i := 0; i < 3; i++ {
		total += i
	}
	return total
}

func typeSwitch(v any) int {
	switch v := v.(type) {
	case int:
		return v
	}
	return 0
}

func closure() func() int {
	return func() int {
		y := value() // want `^assigned to y, but reassigned without using the value$`
		y = 4
		return y
	}
}
