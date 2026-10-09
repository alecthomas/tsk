package options

import (
	"context"
	"os"
	"testing"
)

func TestOptions(t *testing.T) {
	_ = context.Background() // want `^context.Background\(\) could be replaced by t.Context\(\) in TestOptions$`
	_ = context.TODO()       // want `^context.TODO\(\) could be replaced by t.Context\(\) in TestOptions$`
	_ = os.TempDir()         // want `^os.TempDir\(\) could be replaced by t.TempDir\(\) in TestOptions$`
	os.Setenv("A", "b")
	_, _ = os.CreateTemp("", "x")
}
