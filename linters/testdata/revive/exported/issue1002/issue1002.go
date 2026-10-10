// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package golint comment
package golint

// by default code below is valid,
// but if checkPublicInterface is switched on - it should check documentation in interfaces

// Some - some interface
type Some interface {
	Other // should not fail
	// Correct - should do all correct
	Correct()
	// want `^exported: comment on exported interface method Some.SemiCorrect should be of the form "SemiCorrect ..."$`
	SemiCorrect()
	NonCorrect() // want "^exported: public interface method Some.NonCorrect should be commented$"
	// nonCorrect2 has a comment. // want `^exported: comment on exported interface method Some.NonCorrect2 should be of the form "NonCorrect2 ..." to match its exported status, not "nonCorrect2 ..."$`
	NonCorrect2()
}

// Other - just to check names compatibility
type Other interface{}

// for private interfaces it doesn't check docs anyway

type somePrivate interface {
	AllGood()
}
