package pkg

// Names may clash with those of another file.
func AFOO() {} // want `^Method 'AFOO' differs only by capitalization to function 'aFoo' in .*/confusing_naming/confusing_naming\.go$`

func (t *foo) Afoo() {} // want `^Method 'Afoo' differs only by capitalization to method 'aFoo' in .*/confusing_naming/confusing_naming\.go$`

//export cgoexported
func cgoexported() {}

//export CgoExported
func CgoExported() {}

func init() {}

func INIT() {}
