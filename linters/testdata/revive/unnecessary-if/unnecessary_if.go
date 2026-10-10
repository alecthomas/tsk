// Adapted from github.com/mgechev/revive's tests, MIT License.

package unnecessaryif

func unnecessaryIf() bool {
	var cond bool
	var id bool
	var n, m, something int

	// test return replacements
	if cond { // want `^unnecessary-if: replace this conditional by: return cond$`
		return true
	} else {
		return false
	}

	if cond { // want `^unnecessary-if: replace this conditional by: return !\(cond\)$`
		return false
	} else {
		return true
	}

	// test assignment replacements
	if cond { // want `^unnecessary-if: replace this conditional by: id = cond$`
		id = true
	} else {
		id = false
	}

	if cond { // want `^unnecessary-if: replace this conditional by: id = !\(cond\)$`
		id = false
	} else {
		id = true
	}

	// test suggestions for (in)equalities
	//// assignments
	if cond == id { // want `^unnecessary-if: replace this conditional by: id = cond == id$`
		id = true
	} else {
		id = false
	}

	if cond == id { // want `^unnecessary-if: replace this conditional by: id = cond != id$`
		id = false
	} else {
		id = true
	}

	if cond != id { // want `^unnecessary-if: replace this conditional by: id = cond != id$`
		id = true
	} else {
		id = false
	}

	if cond != id { // want `^unnecessary-if: replace this conditional by: id = cond == id$`
		id = false
	} else {
		id = true
	}

	//// return
	if cond == id { // want `^unnecessary-if: replace this conditional by: return cond == id$`
		return true
	} else {
		return false
	}

	if cond == id { // want `^unnecessary-if: replace this conditional by: return cond != id$`
		return false
	} else {
		return true
	}

	if cond != id { // want `^unnecessary-if: replace this conditional by: return cond != id$`
		return true
	} else {
		return false
	}

	if cond != id { // want `^unnecessary-if: replace this conditional by: return cond == id$`
		return false
	} else {
		return true
	}

	//// assignments
	if n <= m { // want `^unnecessary-if: replace this conditional by: id = n <= m$`
		id = true
	} else {
		id = false
	}

	if n <= m { // want `^unnecessary-if: replace this conditional by: id = n > m$`
		id = false
	} else {
		id = true
	}

	if n >= m { // want `^unnecessary-if: replace this conditional by: id = n >= m$`
		id = true
	} else {
		id = false
	}

	if n >= m { // want `^unnecessary-if: replace this conditional by: id = n < m$`
		id = false
	} else {
		id = true
	}

	if n > m { // want `^unnecessary-if: replace this conditional by: id = n > m$`
		id = true
	} else {
		id = false
	}

	if n > m { // want `^unnecessary-if: replace this conditional by: id = n <= m$`
		id = false
	} else {
		id = true
	}

	if n < m { // want `^unnecessary-if: replace this conditional by: id = n < m$`
		id = true
	} else {
		id = false
	}

	if n < m { // want `^unnecessary-if: replace this conditional by: id = n >= m$`
		id = false
	} else {
		id = true
	}

	if (something > 0) && (!id) || (something+10 <= 0) { // want `^unnecessary-if: replace this conditional by: id = !\(\(something > 0\) && \(!id\) \|\| \(something\+10 <= 0\)\)$`
		id = false
	} else {
		id = true
	}

	if n+1 == m*2 { // want `^unnecessary-if: replace this conditional by: id = n\+1 != m\*2$`
		id = false
	} else {
		id = true
	}

	// conditionals with initialization
	if cond := false; cond {
		return true
	} else {
		return false
	}

	if cond := false; cond {
		id = true
	} else {
		id = false
	}

	return id == id
}
