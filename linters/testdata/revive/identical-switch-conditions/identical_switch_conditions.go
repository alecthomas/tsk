// Adapted from github.com/mgechev/revive's tests, MIT License.
package identicalswitchconditions

func enforceSwitchStyle3() {

	switch expression { // skip tagged switch
	case value:
	default:
	}

	switch {
	case a > 0, a < 0:
	case a == 0:
	case a < 0: // want `^identical-switch-conditions: case clause at line 12 has the same condition$`
	default:
	}

	switch {
	case a > 0, a < 0, a > 0: // want `^identical-switch-conditions: case clause at line 19 has the same condition$`
	case a == 0:
	case a < 0: // want `^identical-switch-conditions: case clause at line 19 has the same condition$`
	default:
	}

	switch something {
	case 1:
		switch {
		case a > 0, a < 0, a > 0: // want `^identical-switch-conditions: case clause at line 28 has the same condition$`
		case a == 0:
		}
	default:
	}

	switch {
	case a == 0:
		switch {
		case a > 0, a < 0, a > 0: // want `^identical-switch-conditions: case clause at line 37 has the same condition$`
		case a == 0:
		}
	default:
	}

	switch {
	case lnOpts.IsSocketOpts():
		// ...
		// check for timeout
		fallthrough
	case lnOpts.IsTimeout(), lnOpts.IsSocketOpts(): // want `^identical-switch-conditions: case clause at line 44 has the same condition$`
		// timeout listener with socket options.
		// ...
	case lnOpts.IsTimeout(): // want `^identical-switch-conditions: case clause at line 48 has the same condition$`
		// ...
	default:
		// ...
	}
}
