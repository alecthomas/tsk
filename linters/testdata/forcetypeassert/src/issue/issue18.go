// Adapted from github.com/gostaticanalysis/forcetypeassert's tests, MIT license.
package issue

type M struct{}

func (M) F() (bool, bool) { return true, true }

var _, ok = any(nil).(M).F() // want `right hand must be only type assertion`

func Test(x any) bool {
	_, ok := x.(M).F() // want `right hand must be only type assertion`
	return ok
}
