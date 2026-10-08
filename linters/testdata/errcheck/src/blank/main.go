package blank

import "fmt"

func a() error {
	return nil
}

func b() (string, error) {
	return "", nil
}

func c() string {
	return ""
}

func main() {
	_ = a() // want "is not checked"
	a()     // want "is not checked"
	b()     // want "is not checked"
	c()     // ignored, doesn't return an error

	{
		r, err := b() // fine, we're checking the error
		fmt.Printf("r = %v, err = %v\n", r, err)
	}

	{
		r, _ := b() // want "is not checked"
		fmt.Printf("r = %v\n", r)
	}

	{
		var r, _ = b() // want "is not checked"
		fmt.Printf("r = %v\n", r)
	}

	_ = fmt.Sprint() // not an error
	_ = recover()    // want "is not checked"
}
