// Adapted from github.com/mgechev/revive's tests, MIT License.

package omitzero

type Request struct {
	ForOmitzero string `json:"forOmitZero,omitzero"` // want `^prior Go 1\.24, option "omitzero" is unsupported in json tag$`
	Validated   int    `validate:"omitzero"`
}
