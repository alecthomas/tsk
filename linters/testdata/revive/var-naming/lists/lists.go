// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package lists tests var-naming with an allowlist of ID and a blocklist of VM.
package lists

func foo() string {
	customId := "result"
	customVm := "result"  // want "^var-naming: var customVm should be customVM$"
	customIds := "result" // want "^var-naming: var customIds should be customIDs$"
	_, _ = customVm, customIds
	return customId
}
