// Adapted from github.com/AdminBenni/iota-mixing's tests, MIT License.
package individual

const (
	Above, Other = "above", "other" // want "^Above, Other is a const with r-val in same const block as iota. keep iotas in separate const blocks$"
	Zero         = iota
	One
	Below = "below" // want "^Below is a const with r-val"
)

const (
	A = iota
	B
)
