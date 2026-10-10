// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package max1 tests max-public-structs with a limit of one.
package max1 // want "^max-public-structs: you have exceeded the maximum number \\(1\\) of public struct declarations$"

type Foo struct {
}

type Bar struct {
}

type Baz struct {
}
