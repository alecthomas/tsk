// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package foo ...
package foo

import (
	"context"
	"testing"
)

// AllowedBeforeType is a type that is configured to be allowed before context.Context
type AllowedBeforeType string

// AllowedBeforeStruct is a type that is configured to be allowed before context.Context
type AllowedBeforeStruct struct{}

// AllowedBeforePtrStruct is a type that is configured to be allowed before context.Context
type AllowedBeforePtrStruct struct{}

// A proper context.Context location
func x1(ctx context.Context) { // ok
}

// A proper context.Context location
func x2(ctx context.Context, s string) { // ok
}

// *testing.T is permitted in the linter config for the test
func x3(t *testing.T, ctx context.Context) { // ok
}

func x4(_ AllowedBeforeType, _ AllowedBeforeType, ctx context.Context) { // ok
}

func x5(_, _ AllowedBeforeType, ctx context.Context) { // ok
}

func x6(_ *AllowedBeforePtrStruct, ctx context.Context) { // ok
}

func x7(_ AllowedBeforePtrStruct, ctx context.Context) { // want `^context-as-argument: context\.Context should be the first parameter of a function$`
}

// An invalid context.Context location
func y1(s string, ctx context.Context) { // want `^context-as-argument: context\.Context should be the first parameter of a function$`
}

// An invalid context.Context location with more than 2 args
func y2(s string, r int, ctx context.Context, x int) { // want `^context-as-argument: context\.Context should be the first parameter of a function$`
}

func y3(ctx1 context.Context, ctx2 context.Context, x int) {}

func y4(ctx1 context.Context, ctx2 context.Context, x int, ctx3 context.Context) {} // want `^context-as-argument: context\.Context should be the first parameter of a function$`
