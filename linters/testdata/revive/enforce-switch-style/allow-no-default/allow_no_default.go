// Adapted from github.com/mgechev/revive's tests, MIT License.
package enforceswitchstyleallownodefault

func enforceSwitchStyle() {

	switch expression {
	case condition:
	default:
	}

	switch expression {
	default: // want `^enforce-switch-style: default case clause must be the last one$`
	case condition:
	}

	switch expression {
	case condition:
	}
}
