// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package fixtures imports packages that do not exist, as only the paths matter.
package fixtures

import (
	_ "bithub.com/full/match"
	_ "full"                  // want `^imports-blocklist: should not use the following blocklisted import: "full"$`
	_ "github.com/full/match" // want `^imports-blocklist: should not use the following blocklisted import: "github\.com/full/match"$`
	_ "github.com/full/matche"
	_ "github.com/partical/match/fully"
	_ "pkg/pkg1/wildcard/forward" // want `^imports-blocklist: should not use the following blocklisted import: "pkg/pkg1/wildcard/forward"$`
	_ "pkg/wildcard/forward"      // want `^imports-blocklist: should not use the following blocklisted import: "pkg/wildcard/forward"$`
	_ "strings"
	_ "wildcard/backward"          // want `^imports-blocklist: should not use the following blocklisted import: "wildcard/backward"$`
	_ "wildcard/backward/pkg"      // want `^imports-blocklist: should not use the following blocklisted import: "wildcard/backward/pkg"$`
	_ "wildcard/backward/pkg/pkg1" // want `^imports-blocklist: should not use the following blocklisted import: "wildcard/backward/pkg/pkg1"$`
	_ "wildcard/between"           // want `^imports-blocklist: should not use the following blocklisted import: "wildcard/between"$`
	_ "wildcard/forward"           // want `^imports-blocklist: should not use the following blocklisted import: "wildcard/forward"$`
	_ "wildcard/pkg1/between"      // want `^imports-blocklist: should not use the following blocklisted import: "wildcard/pkg1/between"$`
	_ "wildcard/pkg1/pkg2/between" // want `^imports-blocklist: should not use the following blocklisted import: "wildcard/pkg1/pkg2/between"$`
)
