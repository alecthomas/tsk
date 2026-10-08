// Adapted from github.com/nishanths/predeclared's tests, MIT License.
package qualified

type T struct {
	string int // want "^field string has same name as predeclared identifier$"
	len    int
}

type iface interface {
	copy() // want "^method copy has same name as predeclared identifier$"
}

func (T) append() {} // want "^method append has same name as predeclared identifier$"
