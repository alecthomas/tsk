// Adapted from github.com/mgechev/revive's tests, MIT License.
package enforceswitchstyleallownodefaultallownotlast

func enforceSwitchStyle3() {

	switch expression {
	case condition:
	default:
	}

	switch expression {
	default:
	case condition:
	}

	switch expression {
	case condition:
	}
}
