package a_test

import (
	"example.com/a"
	"testing"
)

func TestF(t *testing.T) {
	a.F() // not inlined
	a.G() // want "Call of a.G should be inlined"
}

func TestG_comment(t *testing.T) {
	a.F() // want "Call of a.F should be inlined"
	a.G() // not inlined
}

func TestT_F(t *testing.T) {
	a.T(0).F() // not inlined
	a.T(0).G() // want `Call of \(a.T\).G should be inlined`
}

func TestT_G(t *testing.T) {
	a.T(0).F() // want `Call of \(a.T\).F should be inlined`
	a.T(0).G() // not inlined
}

