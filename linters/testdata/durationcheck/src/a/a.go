// Adapted from github.com/charithe/durationcheck's tests, Apache License 2.0.
package a

import (
	"b"
	"time"
)

const (
	timeout = 10 * time.Second
	foo     = 10
)

type myStruct struct {
	fieldA int
	fieldB time.Duration
	fieldC *int
}

func validCases() {
	y := 10
	ms := myStruct{fieldA: 10, fieldB: 10 * time.Second, fieldC: func(v int) *int { return &v }(10)}
	intArr := []int{1}

	_ = time.Second * 30
	_ = time.Duration(10) * time.Second
	_ = time.Second * time.Duration(10)
	_ = time.Duration(10+20*5) * time.Second
	_ = time.Duration((foo + 20)) * time.Second
	_ = 2 * 24 * time.Hour
	_ = time.Hour * 2 * 24
	_ = -1 * time.Hour
	_ = time.Duration(y) * time.Second
	_ = time.Duration(someDurationMillis()) * time.Millisecond
	_ = time.Duration(*somePointerDurationMillis()) * time.Millisecond
	_ = timeout / time.Millisecond
	_ = foo * time.Second
	_ = time.Duration(ms.fieldA) * time.Second
	_ = time.Duration(*ms.fieldC) * time.Second
	_ = b.SomeInt * time.Second
	_ = time.Duration(intArr[0]) * time.Second
	_ = time.Duration(y) * 24 * time.Hour

	x := time.Second
	x *= time.Duration(5)
}

func invalidCases() {
	x := 30 * time.Second
	ms := myStruct{fieldA: 10, fieldB: 10 * time.Second}
	tdArr := []time.Duration{1}

	_ = x * time.Second                           // want "Multiplication of durations: `x \\* time.Second`"
	_ = time.Second * x                           // want `Multiplication of durations`
	_ = timeout * time.Millisecond                // want `Multiplication of durations`
	_ = someDuration() * time.Second              // want `Multiplication of durations`
	_ = time.Millisecond * someDuration()         // want `Multiplication of durations`
	_ = *somePointerDuration() * time.Second      // want `Multiplication of durations`
	_ = time.Millisecond * *somePointerDuration() // want `Multiplication of durations`
	_ = (30 * time.Second) * time.Millisecond     // want `Multiplication of durations`
	_ = time.Millisecond * time.Second * 1        // want `Multiplication of durations`
	_ = 1 * time.Second * (time.Second)           // want `Multiplication of durations`
	_ = ms.fieldB * time.Second                   // want `Multiplication of durations`
	_ = b.SomeDuration * time.Second              // want `Multiplication of durations`
	_ = time.Duration(tdArr[0]) * time.Second     // want `Multiplication of durations`
	x *= time.Second                              // want "Multiplication of durations: `x \\*= time.Second`"
	x *= time.Duration(5) * time.Second           // want "`x \\*= time.Duration\\(5\\)\\*time.Second`"
	x *= x*time.Second + x                        // want "`x \\*= x\\*time.Second\\+x`" "`x \\* time.Second`"
	x *= (x + time.Second) * -x                   // want "`x \\*= \\(x\\+time.Second\\)\\*-x`" "`\\(x \\+ time.Second\\) \\* -x`"
}

func someDuration() time.Duration {
	return 10 * time.Second
}

func someDurationMillis() int {
	return 10
}

func somePointerDuration() *time.Duration {
	v := 10 * time.Second
	return &v
}

func somePointerDurationMillis() *int {
	v := 10
	return &v
}
