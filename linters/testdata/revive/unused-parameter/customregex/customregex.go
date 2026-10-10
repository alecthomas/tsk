// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package customregex tests unused-parameter with allow-regex "^xxx".
package customregex

func f0(xxxParam int) {}

// still works with _

func f1(_ int) {}

func f2(yyyParam int) { // want "^unused-parameter: parameter 'yyyParam' seems to be unused, consider removing or renaming it to match \\^xxx$"
}
