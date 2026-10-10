// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package waitgroupbyvalue tests waitgroup-by-value.
package waitgroupbyvalue

import (
	"sync"
)

func foo(a int, b float32, c rune, d sync.WaitGroup) { // want "^waitgroup-by-value: sync.WaitGroup passed by value, the function will get a copy of the original one$"

}

func bar(a, b sync.WaitGroup) { // want "^waitgroup-by-value: sync.WaitGroup passed by value, the function will get a copy of the original one$"

}

func baz(zz sync.WaitGroup) { // want "^waitgroup-by-value: sync.WaitGroup passed by value, the function will get a copy of the original one$"

}

func ok(zz *sync.WaitGroup) {

}
