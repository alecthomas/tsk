// Package slices stubs golang.org/x/exp/slices.
package slices

func Contains[S ~[]E, E comparable](s S, v E) bool { return false }

func Index[S ~[]E, E comparable](s S, v E) int { return -1 }

// Chunked has no standard library replacement.
func Chunked[S ~[]E, E any](s S, n int) []S { return nil }
