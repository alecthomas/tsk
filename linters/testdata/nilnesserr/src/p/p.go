// Adapted from github.com/alingse/nilnesserr's tests, MIT License.
package p

import "fmt"

func do() error  { return nil }
func do2() error { return nil }

func use(err error) {}

func _() error {
	err1 := do()
	if err1 != nil {
		return err1
	}
	if err2 := do2(); err2 != nil {
		return err1 // want "^return a nil value error after check error$"
	}
	return nil
}

func _() {
	err1 := do()
	if err1 != nil {
		return
	}
	if err2 := do2(); err2 != nil {
		use(err1) // want "^call function with a nil value error after check error$"
	}
}

func _() error {
	err1 := do()
	if err1 != nil {
		return err1
	}
	if err2 := do2(); err2 != nil {
		return fmt.Errorf("wrap: %w", err1) // want "^call variadic function with a nil value error after check error$"
	}
	return nil
}

func _() error {
	err1 := do()
	if err1 != nil {
		return err1
	}
	if err2 := do2(); err2 != nil {
		return err2
	}
	return nil
}
