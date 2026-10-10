// Adapted from github.com/mgechev/revive's tests, MIT License.
package enforceswitchstyleallownotlast

func enforceSwitchStyle2() {

	switch expression {
	case condition:
	default:
	}

	switch expression {
	default:
	case condition:
	}

	switch expression { // want `^enforce-switch-style: switch must have a default case clause$`
	case condition:
	}
}
