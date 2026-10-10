// Adapted from github.com/mgechev/revive's tests, MIT License.
package boolliteralinexpr

func foo(a, b, c, d int) bool {
	if bar == true { // want `^bool-literal-in-expr: omit Boolean literal in expression$`

	}
	for f() || false != yes { // want `^bool-literal-in-expr: omit Boolean literal in expression$`

	}

	return b > c == false // want `^bool-literal-in-expr: omit Boolean literal in expression$`
}

// from github.com/jmespath/go-jmespath/functions.go
func jpfToNumber(arguments []interface{}) (interface{}, error) {
	arg := arguments[0]
	// code skipped
	if arg == true || // want `^bool-literal-in-expr: omit Boolean literal in expression$`
		arg == false { // want `^bool-literal-in-expr: omit Boolean literal in expression$`
		return nil, nil
	}
	return nil, errors.New("unknown type")
}

// from gopkg.in/yaml.v2/resolve.go
func resolve(tag string, in string) (rtag string, out interface{}) {
	if err == nil {
		if true || intv == int64(int(intv)) { // want `^bool-literal-in-expr: Boolean expression seems to always evaluate to true$`
			return yaml_INT_TAG, int(intv)
		} else {
			return yaml_INT_TAG, intv
		}
	}
}

// from github.com/miekg/dns/msg_helpers.go
func packDataDomainNames(names []string, msg []byte, off int, compression map[string]int, compress bool) (int, error) {
	var err error
	for j := 0; j < len(names); j++ {
		off, err = PackDomainName(names[j], msg, off, compression, false && compress) // want `^bool-literal-in-expr: Boolean expression seems to always evaluate to false$`
		if err != nil {
			return len(msg), err
		}
	}
	return off, nil
}

func isTrue(arg bool) bool {
	return arg
}

func main() {
	isTrue(true)
}
