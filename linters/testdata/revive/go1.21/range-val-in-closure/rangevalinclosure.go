// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package rangevalinclosure tests range-val-in-closure.
package rangevalinclosure

import (
	"context"
	"fmt"
)

type group int

func (group) run(_ context.Context, _ int) {}

var (
	groups []group
	m      struct{ opts struct{ Context context.Context } }
)

type t struct{ key, otherField int }

func foo() {
	mySlice := []string{"A", "B", "C"}
	for index, value := range mySlice {
		go func() {
			fmt.Printf("Index: %d\n", index) // want "^range-val-in-closure: loop variable index captured by func literal$"
			fmt.Printf("Value: %s\n", value) // want "^range-val-in-closure: loop variable value captured by func literal$"
		}()
	}

	myDict := make(map[string]int)
	myDict["A"] = 1
	myDict["B"] = 2
	myDict["C"] = 3
	for key, value := range myDict {
		defer func() {
			fmt.Printf("Index: %s\n", key)   // want "^range-val-in-closure: loop variable key captured by func literal$"
			fmt.Printf("Value: %d\n", value) // want "^range-val-in-closure: loop variable value captured by func literal$"
		}()
	}

	for i, newg := range groups {
		go func(newg group) {
			newg.run(m.opts.Context, i) // want "^range-val-in-closure: loop variable i captured by func literal$"
		}(newg)
	}

	for i, newg := range groups {
		newg := newg
		go func() {
			newg.run(m.opts.Context, i) // want "^range-val-in-closure: loop variable i captured by func literal$"
		}()
	}

	for i := 0; i < 3; i++ {
		go func() {
			print(i) // want "^range-val-in-closure: loop variable i captured by func literal$"
		}()
	}

	for i := 0; i < 3; i++ {
		go func() {
			print(i)
		}()
		print()
	}
}

func issue637() {
	for key := range []int{} {
		myKey := key
		go func() {
			fmt.Println(t{
				key:        myKey,
				otherField: (10 + key), // want "^range-val-in-closure: loop variable key captured by func literal$"
			})
		}()
	}
}
