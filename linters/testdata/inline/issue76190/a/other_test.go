package a

import "testing"

func Test(t *testing.T) {
	F()      // want "Call of a.F should be inlined"
	G()      // want "Call of a.G should be inlined"
	print(K) // want "Constant K should be inlined"
	var _ A  // want "Type alias A should be inlined"
}

func TestG_comment(t *testing.T) {
	F() // want "Call of a.F should be inlined"
	G() // not inlined
}

func TestT_F(t *testing.T) {
	T(0).F() // not inlined
	T(0).G() // want `Call of \(a.T\).G should be inlined`
}

func TestT_G(t *testing.T) {
	T(0).F() // want `Call of \(a.T\).F should be inlined`
	T(0).G() // not inlined
}

func TestK(t *testing.T) {
	print(K) // not inlined
}

func TestA(t *testing.T) {
	var _ A // not inlined
}

