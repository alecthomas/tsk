// Adapted from github.com/raeperd/recvcheck's tests, MIT License.
package p

type Mixed struct{} // want `^the methods of "Mixed" use pointer receiver and non-pointer receiver\.$`

func (m Mixed) A()  {}
func (m *Mixed) B() {}

type Pointers struct{}

func (p *Pointers) A() {}
func (p *Pointers) B() {}

type Decoder struct{}

func (d Decoder) String() string             { return "" }
func (d *Decoder) UnmarshalJSON([]byte) error { return nil }

type Excluded struct{}

func (e Excluded) A()  {}
func (e *Excluded) B() {}

type Generic[T any] struct{}

func (g Generic[T]) A()  {}
func (g *Generic[T]) B() {}
