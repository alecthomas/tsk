// Adapted from github.com/mgechev/revive's tests, MIT License.

package barereturn

func bare1() (int, int, error) {
	go func(int) (a int) {
		return // want `^bare-return: avoid using bare returns, please add return expressions$`
	}(5)
	return 0, 0, nil
}

func bare2(a, b int) (int, error, int) {
	defer func(int) (a int) {
		return // want `^bare-return: avoid using bare returns, please add return expressions$`
	}(5)
	return 0, nil, 0
}

func bare3(p string, q int) (a int, b float32, c string, d string) {
	go func(int, int) (a int, b int) {
		return a, b
	}(5, 6)

	defer func(int) (a int) {
		return a
	}(5)

	return // want `^bare-return: avoid using bare returns, please add return expressions$`
}

func bare4(a string, b int) string {
	return a
}

func bare5(a string, b int) {
	return
}

// NR tests for issue #280
func f280_1() (err error) {
	func() {
		return
	}()

	return nil
}

func f280_2() (err error) {
	func() (r int) {
		return // want `^bare-return: avoid using bare returns, please add return expressions$`
	}()

	return nil
}

func f280_3() (err error) {
	func() (r int) {
		return 1
	}()

	return // want `^bare-return: avoid using bare returns, please add return expressions$`
}

func f280_4() (err error) {
	func() (r int) {
		return func() (r int) {
			return // want `^bare-return: avoid using bare returns, please add return expressions$`
		}()
	}()

	return nil
}
