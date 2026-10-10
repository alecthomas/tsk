// Before Go 1.21 the go.mod version is not a requirement, so the
// constraint is not redundant.

/* The leading comment keeps the go command from reading the constraint. */ //go:build go1.20

package pkg
