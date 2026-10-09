package p

func simple() {}

func complex(a, b bool, xs []int, ch chan int) int { // want `^calculated cyclomatic complexity for function complex is 11, max is 10$`
	n := 0
	if a && b || a {
		n++
	}
	for i := 0; i < 3; i++ {
		n++
	}
	for range xs {
		n++
	}
	switch n {
	case 1:
	case 2:
	}
	select {
	case <-ch:
	default:
	}
	if n > 1 {
		n--
	}
	return n
}
