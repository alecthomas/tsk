// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package timeequal tests time-equal.
package timeequal

import "time"

func t() bool {
	t := time.Now()
	u := t

	if !t.After(u) {
		return t == u // want "^use t.Equal\\(u\\) instead of \"==\" operator$"
	}

	return t != u // want "^use !t.Equal\\(u\\) instead of \"!=\" operator$"
}

// issue #846
func isNow(t time.Time) bool    { return t == time.Now() } // want "^use t.Equal\\(time.Now\\(\\)\\) instead of \"==\" operator$"
func isNotNow(t time.Time) bool { return time.Now() != t } // want "^use !time.Now\\(\\).Equal\\(t\\) instead of \"!=\" operator$"

func notTime(a, b *time.Time) bool { return a == b }
