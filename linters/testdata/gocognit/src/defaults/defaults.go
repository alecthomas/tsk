package defaults

// thirty costs 30: the if, and 29 changes of logical operator.
func thirty(a, b bool) bool {
	if a || b && a || b && a || b && a || b && a || b && a || b && a || b && a || b && a || b && a || b && a || b && a || b && a || b && a || b && a || b {
		return true
	}
	return false
}

// thirtyOne costs one more.
func thirtyOne(a, b bool) bool { // want "^cognitive complexity 31 of func `thirtyOne` is high \\(> 30\\)$"
	if a || b && a || b && a || b && a || b && a || b && a || b && a || b && a || b && a || b && a || b && a || b && a || b && a || b && a || b && a || b && a {
		return true
	}
	return false
}
