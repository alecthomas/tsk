package lines

import _ "fmt" // Imports may be long: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

//go:generate echo Directives may be long: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

var short = 1

var long = 1 // want "^The line is \\d+ characters long, which exceeds the maximum of 80 characters\\.$"

// Tabs count as tab-width characters, and each character as one.
func f() {
	_ = 1 // éééééééééééééééééééééééééééééééééééééééé
	_ = 2 // want "^The line is \\d+ characters long, which exceeds the maximum of 80 characters\\.$"
}

