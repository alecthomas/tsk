// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package datarace tests datarace before Go 1.22, where range values are per loop.
package datarace

func datarace() (r int, c rune) {
	for _, p := range []int{1, 2} {
		go func() {
			print(r) // want "^datarace: potential datarace: return value r is captured \\(by-reference\\) in goroutine$"
			print(p) // want "^datarace: datarace: range value p is captured \\(by-reference\\) in goroutine$"
		}()
		for i, p1 := range []int{1, 2} {
			a := p1
			go func() {
				print(r)  // want "^datarace: potential datarace: return value r is captured \\(by-reference\\) in goroutine$"
				print(p)  // want "^datarace: datarace: range value p is captured \\(by-reference\\) in goroutine$"
				print(p1) // want "^datarace: datarace: range value p1 is captured \\(by-reference\\) in goroutine$"
				print(a)
				print(i) // want "^datarace: datarace: range value i is captured \\(by-reference\\) in goroutine$"
			}()
			print(i)
			print(p)
			go func() {
				_ = c // want "^datarace: potential datarace: return value c is captured \\(by-reference\\) in goroutine$"
			}()
		}
	}
	go func() {
		print(r) // want "^datarace: potential datarace: return value r is captured \\(by-reference\\) in goroutine$"
	}()
	print(r)
	return
}
