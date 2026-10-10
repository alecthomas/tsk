// Adapted from github.com/mgechev/revive's tests, MIT License.

package uselessfallthrough

func uselessFallthrough(a int, goos string) {

	switch a {
	case 0:
		println()
		fallthrough
	default:
	}

	switch a {
	case 0:
		fallthrough // want `^useless-fallthrough: this "fallthrough" can be removed by consolidating this case clause with the next one$`
	case 1:
		println()
	default:
	}

	switch a {
	case 0:
		fallthrough // want `^useless-fallthrough: this "fallthrough" can be removed by consolidating this case clause with the next one$`
	case 1:
		fallthrough // want `^useless-fallthrough: this "fallthrough" can be removed by consolidating this case clause with the next one$`
	case 2:
		println()
	default:
	}

	switch a {
	case 0:
		fallthrough
	default:
		println()
	}

	switch a {
	case 0:
		fallthrough
	default:
		println()
	case 1:
		fallthrough // want `^useless-fallthrough: this "fallthrough" can be removed by consolidating this case clause with the next one$`
	case 2:
		println()
	}

	switch a {
	case 0:
		fallthrough
	default:
		println()
	}

	switch goos {
	case "linux":
		// TODO(bradfitz): be fancy and use linkat with AT_EMPTY_PATH to avoid
		// copying? I couldn't get it to work, though.
		// For now, just do the same thing as every other Unix and copy
		// the binary.
		fallthrough // Reported with confidence 0.5, below the default threshold.
	case "darwin", "freebsd", "openbsd", "netbsd":
		return
	case "windows":
		return
	default:
		return
	}

	switch a {
	case 0:
		//foo:bar
		fallthrough
	default:
		println()
	}

}
