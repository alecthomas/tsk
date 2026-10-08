package checkalias

func loops() {
	for i, v := range []int{1, 2, 3} {
		i := i      // want `The copy of the 'for' variable "i" can be deleted \(Go 1\.22\+\)`
		_i := i     // want `The copy of the 'for' variable "i" can be deleted \(Go 1\.22\+\)`
		b, _v := 1, v // want `The copy of the 'for' variable "v" can be deleted \(Go 1\.22\+\)`
		_, _, _ = _i, b, _v
	}
}
