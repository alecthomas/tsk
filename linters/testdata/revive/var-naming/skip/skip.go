// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package skip tests var-naming with skipInitialismNameChecks and upperCaseConst.
package skip

const HttpRes = 200

func readJson() {}

type SshConfig struct {
	keyPath string
}

func varNamingAllowListBlocklistSkipInitialismNameChecks() string {
	customId := "result"
	customVm := "result"
	_ = customVm
	customIds := "result"
	_ = customIds
	return customId
}

const SOME_CONST_2 = 2
const _SOME_PRIVATE_CONST_2 = 2

const (
	SOME_CONST_3          = 3
	_SOME_PRIVATE_CONST_3 = 3
	VER                   = 0
)

// Only constants may be in upper case.
var SOME_VAR_1 = 1 // want "^var-naming: don't use ALL_CAPS in Go names; use CamelCase$"

var under_score = 1 // want "^var-naming: don't use underscores in Go names; var under_score should be underScore$"
