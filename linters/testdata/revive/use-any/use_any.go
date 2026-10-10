// Adapted from github.com/mgechev/revive's tests, MIT License.

package pkg

var i interface{} // want `^use-any: since Go 1\.18 'interface\{\}' can be replaced by 'any'$`

type t interface{}   // want `^use-any: since Go 1\.18 'interface\{\}' can be replaced by 'any'$`
type a = interface{} // want `^use-any: since Go 1\.18 'interface\{\}' can be replaced by 'any'$`

func any1(a interface{}) { // want `^use-any: since Go 1\.18 'interface\{\}' can be replaced by 'any'$`
	m1 := map[interface{}]string{}     // want `^use-any: since Go 1\.18 'interface\{\}' can be replaced by 'any'$`
	m2 := map[int]interface{}{}        // want `^use-any: since Go 1\.18 'interface\{\}' can be replaced by 'any'$`
	a2 := []interface{}{}              // want `^use-any: since Go 1\.18 'interface\{\}' can be replaced by 'any'$`
	m3 := make(map[int]interface{}, 1) // want `^use-any: since Go 1\.18 'interface\{\}' can be replaced by 'any'$`
	a3 := make([]interface{}, 2)       // want `^use-any: since Go 1\.18 'interface\{\}' can be replaced by 'any'$`
	_, _, _, _, _ = m1, m2, a2, m3, a3
}

func any2(a int) interface{} { return nil } // want `^use-any: since Go 1\.18 'interface\{\}' can be replaced by 'any'$`

var ni interface{ Close() }

type nt interface{ Close() }
type na = interface{ Close() }

func nany1(a interface{ Close() }) {
	nm1 := map[interface{ Close() }]string{}
	nm2 := map[int]interface{ Close() }{}
	na := []interface{ Close() }{}
	nm3 := make(map[int]interface{ Close() }, 1)
	na2 := make([]interface{ Close() }, 2)
	_, _, _, _, _ = nm1, nm2, na, nm3, na2
}

func nany2(a int) interface{ Close() } { return nil }
