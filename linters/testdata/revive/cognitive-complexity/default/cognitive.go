// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package cognitivedefault tests cognitive-complexity with the default limit.
package cognitivedefault

func l() bool { // want "^cognitive-complexity: function l has cognitive complexity 8 \\(> max enabled 7\\)$"
	total, max := 0, 10
	for i := 1; i <= max; i++ {
		for j := 2; j < i; j++ {
			if (i%j == 0) || (i%j == 1) {
				continue
			}
			total += i
		}
	}
	return total > 0 && max > 0
}
