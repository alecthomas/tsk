package assert

func main() {
	var i interface{}
	_ = i.(string) // want "^Error return value is not checked$"

	handleInterface(i.(string)) // want "is not checked"

	if i.(string) == "hello" { // want "is not checked"
		//
	}

	switch i.(type) {
	case string:
	case int:
		_ = i.(int) // want "is not checked"
	case nil:
	}

	s, ok := i.(string) // checked
	_, _ = s, ok
	s2, _ := i.(string) // not reported without check-blank
	_ = s2
}

func handleInterface(i interface{}) string {
	return i.(string) // want "is not checked"
}
