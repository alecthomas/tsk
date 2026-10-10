// Adapted from github.com/mgechev/revive's tests, MIT License.

//go:build !tsknever
/* want `^redundant-build-tag: The build tag "// \+build" is redundant since Go 1.17 and can be removed$` */ // +build !tsknever

package pkg
