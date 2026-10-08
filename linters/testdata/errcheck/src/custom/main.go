package custom

import "fmt"

type ErrorMakerInterface interface {
	MakeNilError() error
}
type ErrorMakerInterfaceWrapper interface {
	ErrorMakerInterface
}

func main() {
	var emiw ErrorMakerInterfaceWrapper
	emiw.MakeNilError()    // ok, custom exclude
	fmt.Println("checked") // want "^Error return value of `fmt.Println` is not checked$"
}
