// Adapted from github.com/karamaru-alpha/copyloopvar's tests, MIT License.
package basic

func loops() {
	for i, v := range []int{1, 2, 3} {
		i := i // want `The copy of the 'for' variable "i" can be deleted \(Go 1\.22\+\)`
		_i := i
		v := v // want `The copy of the 'for' variable "v" can be deleted \(Go 1\.22\+\)`
		_v := v
		a, i := 1, i // want `The copy of the 'for' variable "i" can be deleted \(Go 1\.22\+\)`
		b, _i := 1, i
		c, v := 1, v // want `The copy of the 'for' variable "v" can be deleted \(Go 1\.22\+\)`
		d, _v := 1, v
		e := false
		_, _, _, _, _, _, _, _, _ = i, _i, v, _v, a, b, c, d, e
	}

	for i, j := 1, 1; i+j <= 3; i++ {
		i := i // want `The copy of the 'for' variable "i" can be deleted \(Go 1\.22\+\)`
		_i := i
		j := j // want `The copy of the 'for' variable "j" can be deleted \(Go 1\.22\+\)`
		_j := j
		a, i := 1, i // want `The copy of the 'for' variable "i" can be deleted \(Go 1\.22\+\)`
		b, _i := 1, i
		_, _, _, _, _ = i, _i, _j, a, b
	}

	var t struct {
		Bool bool
	}
	for _, t.Bool = range []bool{true, false} {
		t.Bool = t.Bool
	}
}
