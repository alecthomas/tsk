// Adapted from github.com/mgechev/revive's tests, MIT License.
package enforcerepeatedargtypestylemixedshortfull

func compliantFunc(a, b int, c string) (x int, y int, z string) // Must not match - compliant with rule

func nonCompliantFunc1(a, b int, c string) (x, y int, z string)         { panic("implement me") } // want `^enforce-repeated-arg-type-style: return types should not be omitted$`
func nonCompliantFunc2(a int, b int, c string) (x int, y int, z string) { panic("implement me") } // want `^enforce-repeated-arg-type-style: repeated argument type "int" can be omitted$`
