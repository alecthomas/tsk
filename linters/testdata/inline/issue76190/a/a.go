package a

//go:fix inline
func F() { print("F") } // want F:`goFixInline {"name":"a.F"`
//go:fix inline
func G() { print("G") } // want G:`goFixInline {"name":"a.G"`

type T int
//go:fix inline
func (T) F() { print("T.F") } // want F:`goFixInline {"name":"\(a.T\).F"`
//go:fix inline
func (T) G() { print("T.G") } // want G:`goFixInline {"name":"\(a.T\).G"`

//go:fix inline
type A = T // want A:`goFixInline alias`

//go:fix inline
const K = One // want K:`goFixInline const {"rhsName":"One","rhsPkgPath":"example.com/a"`

const One = 1

