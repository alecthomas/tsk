// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

import (
	"crypto/md5"
	_ "crypto/md5" // want `^duplicated-imports: Package "crypto/md5" already imported$`
	"strings"
	str "strings" // want `^duplicated-imports: Package "strings" already imported$`
)

var _ = md5.New
var _ = strings.ToUpper
var _ = str.ToLower
