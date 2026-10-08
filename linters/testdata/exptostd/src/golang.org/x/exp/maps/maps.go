// Package maps stubs golang.org/x/exp/maps.
package maps

func Keys[M ~map[K]V, K comparable, V any](m M) []K { return nil }

func Equal[M1, M2 ~map[K]V, K, V comparable](m1 M1, m2 M2) bool { return false }

func Clear[M ~map[K]V, K comparable, V any](m M) {}
