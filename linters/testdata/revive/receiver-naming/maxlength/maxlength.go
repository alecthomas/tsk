// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

type o struct{}
type tw struct{}
type thr struct{}

func (o *o) f1()     {}
func (tw *tw) f2()   {}
func (thr *thr) f3() {} // want "^receiver-naming: receiver name thr is longer than 2 characters$"
