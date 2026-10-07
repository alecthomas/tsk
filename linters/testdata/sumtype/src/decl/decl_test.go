package decl

import "testing"

func TestFirst(t *testing.T) {
	switch First(nil).(type) { // want `sum type "First" .*missing cases for FirstB$`
	case *FirstA:
	}
}
