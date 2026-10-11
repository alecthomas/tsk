// The leading comments keep the go command from reading the constraints.

/* A newer version than go.mod's is not redundant. */ //go:build go1.30

/* Nor is an expression. */ //go:build go1.21 && !tsknever

package pkg
