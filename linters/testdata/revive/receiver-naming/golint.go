// Adapted from github.com/mgechev/revive's tests, MIT License.

// Test for bad receiver names.

// Package foo ...
package foo

type foo struct{}

func (this foo) f1() { // want "^receiver-naming: receiver name should be a reflection of its identity; don't use generic names such as \"this\" or \"self\"$"
}

func (self foo) f2() { // want "^receiver-naming: receiver name should be a reflection of its identity; don't use generic names such as \"this\" or \"self\"$"
}

func (f foo) f3() {
}

func (foo) f4() {
}

type bar struct{}

func (b bar) f1() {
}

func (b bar) f2() {
}

func (a bar) f3() { // want "^receiver-naming: receiver name a should be consistent with previous receiver name b for bar$"
}

func (a *bar) f4() { // want "^receiver-naming: receiver name a should be consistent with previous receiver name b for bar$"
}

func (b *bar) f5() {
}

func (bar) f6() {
}

func (_ *bar) f7() { // want "^receiver-naming: receiver name should not be an underscore, omit the name if it is unused$"
}

type multiError struct{}

func (me multiError) f8() {
}
