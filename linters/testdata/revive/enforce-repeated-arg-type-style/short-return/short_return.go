// Adapted from github.com/mgechev/revive's tests, MIT License.
package enforcerepeatedargtypestyleshortreturn

func compliantFunc() (a, b int, c string) { panic("implement me") } // Must not match - compliant with rule
func compliantFunc2() (int, int, string)  // Must not match - compliant with rule

func nonCompliantFunc1() (a int, b int, c string) { panic("implement me") } // want `^enforce-repeated-arg-type-style: repeated return type "int" can be omitted$`
func nonCompliantFunc2() (a int, b, c int)        { panic("implement me") } // want `^enforce-repeated-arg-type-style: repeated return type "int" can be omitted$`

type myStruct struct{}

func (m myStruct) compliantMethod() (a, b int, c string) { panic("implement me") } // Must not match - compliant with rule

func (m myStruct) nonCompliantMethod1() (a int, b int, c string) { panic("implement me") } // want `^enforce-repeated-arg-type-style: repeated return type "int" can be omitted$`
func (m myStruct) nonCompliantMethod2() (a int, b, c int)        { panic("implement me") } // want `^enforce-repeated-arg-type-style: repeated return type "int" can be omitted$`

func singleArgFunction() (a int) { panic("implement me") } // Must not match - only one return

func multiTypeArgs() (a int, b string, c float64) { panic("implement me") } // Must not match - different types for each return

func mixedCompliance() (a, b int, c int, d string) { panic("implement me") } // want `^enforce-repeated-arg-type-style: repeated return type "int" can be omitted$`
