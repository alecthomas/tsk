// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

import (
	"crypto/md5"
	_ "crypto/md5"
	crypto "crypto/md5"
	md5 "crypto/md5" // want "^redundant-import-alias: Import alias \"md5\" is redundant$"
	"strings"
	str "strings"
	strings "strings" // want "^redundant-import-alias: Import alias \"strings\" is redundant$"
)
