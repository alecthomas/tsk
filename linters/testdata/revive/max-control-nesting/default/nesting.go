// Adapted from github.com/mgechev/revive's tests, MIT License.
package nestingdefault

func mcn() {
	if true {
		if true {
			if true {
				if true {
					if true {
						if true { // want "^max-control-nesting: control flow nesting exceeds 5$"
						}
					}
				}
			}
		}
	}
}
