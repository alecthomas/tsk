// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

import (
	"crypto/md5"  // want `^imports-blocklist: should not use the following blocklisted import: "crypto/md5"$`
	"crypto/sha1" // want `^imports-blocklist: should not use the following blocklisted import: "crypto/sha1"$`
	"strings"
)

var _ = md5.New
var _ = sha1.New
var _ = strings.ToUpper
