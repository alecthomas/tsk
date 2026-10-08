package defaults

import "fmt"

func Print() {
	fmt.Println("hi")  // want "^use of `fmt.Println` forbidden by pattern `\\^\\(fmt\\\\.Print\\(\\|f\\|ln\\)\\|print\\|println\\)\\$`$"
	fmt.Printf("hi")   // want "use of `fmt.Printf` forbidden"
	print("hi")        // want "use of `print` forbidden"
	_ = fmt.Sprint("") // fine
}

// Declared names, as of fields and parameters, are not uses.
type printer struct{ print int }

func shadow(println int) {}
