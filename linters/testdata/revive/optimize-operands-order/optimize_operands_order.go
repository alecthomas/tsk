// Adapted from github.com/mgechev/revive's tests, MIT License.
package optimizeoperandsorder

func conditionalExpr(x, y bool) bool {
	equal := x == y // should not match, not AND or OR operators
	if x || y {     // should not match, no caller
		return true
	}
	or := caller(x, y) || y // want `^optimize-operands-order: for better performance 'caller\(x, y\) \|\| y' might be rewritten as 'y \|\| caller\(x, y\)'$`
	if caller(x, y) || y { // want `^optimize-operands-order: for better performance 'caller\(x, y\) \|\| y' might be rewritten as 'y \|\| caller\(x, y\)'$`
		return true
	}

	switch {
	case x == y:
		return y
	case caller(x, y) && y: // want `^optimize-operands-order: for better performance 'caller\(x, y\) \&\& y' might be rewritten as 'y \&\& caller\(x, y\)'$`
		return x
	}

	complexExpr := caller(caller(x, y) && y, y) || y // want `^optimize-operands-order: for better performance 'caller\(caller\(x, y\) \&\& y, y\) \|\| y' might be rewritten as 'y \|\| caller\(caller\(x, y\) \&\& y, y\)'$` `^optimize-operands-order: for better performance 'caller\(x, y\) \&\& y' might be rewritten as 'y \&\& caller\(x, y\)'$`
	// Reported below: for better performance 'caller(caller(x, y) && y, y) || y' might be rewritten as 'y || caller(caller(x, y) && y, y)'
	// Reported below: for better performance 'caller(x, y) && y' might be rewritten as 'y && caller(x, y)'

	noSwap := caller(x, y) || (x && caller(y, x)) // should not match, caller in the right operand

	callRight := caller(x, y) && (x && caller(y, x)) // should not match, caller in the right operand
	return caller(x, y) && y // want `^optimize-operands-order: for better performance 'caller\(x, y\) \&\& y' might be rewritten as 'y \&\& caller\(x, y\)'$`
}

func conditionalExprSlice(s []string) bool {
	if len(s) > 0 || s[0] == "" { // should not match, not safe
		return false
	}

	f := func() bool {
		len(s) > 1
	}

	if f() || s[0] == "test" { // want `^optimize-operands-order: for better performance 'f\(\) \|\| s\[0\] == "test"' might be rewritten as 's\[0\] == "test" \|\| f\(\)'$`
		return true
	}
}

func caller(x, y bool) bool {
	return true
}
