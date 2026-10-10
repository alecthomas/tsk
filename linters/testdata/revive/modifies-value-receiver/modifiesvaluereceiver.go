// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package modifiesvaluereceiver tests modifies-value-receiver.
package modifiesvaluereceiver

type data struct {
	num   int
	key   *string
	items map[string]bool
}

func (this data) vmethod() {
	this.num = 8 // want "^modifies-value-receiver: suspicious assignment to a by-value method receiver$"
	*this.key = "v.key"
	this.items = make(map[string]bool) // want "^modifies-value-receiver: suspicious assignment to a by-value method receiver$"
	this.items["vmethod"] = true
}

type A struct{ whatever bool }

func (a A) Foo() *A {
	a.whatever = true
	return &a
}

func (a A) Clone() (*A, error) {
	a.whatever = true
	return &a, nil
}

type JailerCommandBuilder struct{ bin string }

// WithBin will set the specific bin path to the builder.
func (b JailerCommandBuilder) WithBin(bin string) JailerCommandBuilder {
	b.bin = bin
	return b
}

var other int

func (this data) incrementDecrement() {
	this.num++ // want "^modifies-value-receiver: suspicious assignment to a by-value method receiver$"
	this.num-- // want "^modifies-value-receiver: suspicious assignment to a by-value method receiver$"
	other++
}

func (this data) assignmentOperators() {
	this.num += 1  // want "^modifies-value-receiver: suspicious assignment to a by-value method receiver$"
	this.num -= 1  // want "^modifies-value-receiver: suspicious assignment to a by-value method receiver$"
	this.num *= 1  // want "^modifies-value-receiver: suspicious assignment to a by-value method receiver$"
	this.num /= 1  // want "^modifies-value-receiver: suspicious assignment to a by-value method receiver$"
	this.num %= 1  // want "^modifies-value-receiver: suspicious assignment to a by-value method receiver$"
	this.num &= 1  // want "^modifies-value-receiver: suspicious assignment to a by-value method receiver$"
	this.num ^= 1  // want "^modifies-value-receiver: suspicious assignment to a by-value method receiver$"
	this.num |= 1  // want "^modifies-value-receiver: suspicious assignment to a by-value method receiver$"
	this.num >>= 1 // want "^modifies-value-receiver: suspicious assignment to a by-value method receiver$"
	this.num <<= 1 // want "^modifies-value-receiver: suspicious assignment to a by-value method receiver$"
}

type list []int

func (l list) set() {
	l = nil
}
