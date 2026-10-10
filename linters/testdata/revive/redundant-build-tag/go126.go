// The leading comments keep the go command from reading the constraints.

/* want `^redundant-build-tag: The build tag "//go:build go1.26" is redundant for Go 1.26 and can be removed$` */ //go:build go1.26

package pkg
