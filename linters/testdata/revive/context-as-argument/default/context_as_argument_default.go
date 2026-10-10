// Adapted from github.com/mgechev/revive's tests, MIT License.

package foo

import (
	"context"
	"testing"
)

type AllowedBeforePtrStruct struct{}

func x(_ AllowedBeforePtrStruct, ctx context.Context) { // want `^context-as-argument: context\.Context should be the first parameter of a function$`
}

func y(t *testing.T, ctx context.Context) { // want `^context-as-argument: context\.Context should be the first parameter of a function$`
}
