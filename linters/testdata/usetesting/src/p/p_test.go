package p

import (
	"context"
	"os"
	"testing"
)

func TestDefaults(t *testing.T) {
	os.Setenv("A", "b")             // want `^os.Setenv\(\) could be replaced by t.Setenv\(\) in TestDefaults$`
	_ = os.Chdir("/")               // want `^os.Chdir\(\) could be replaced by t.Chdir\(\) in TestDefaults$`
	_, _ = os.MkdirTemp("", "x")    // want `^os.MkdirTemp\(\) could be replaced by t.TempDir\(\) in TestDefaults$`
	_, _ = os.CreateTemp("", "x")   // want `^os.CreateTemp\("", ...\) could be replaced by os.CreateTemp\(t.TempDir\(\), ...\) in TestDefaults$`
	_, _ = os.CreateTemp("/tmp", "x")
	_ = os.TempDir()
	_ = context.Background()
	t.Run("sub", func(t *testing.T) {
		os.Setenv("A", "b") // want `^os.Setenv\(\) could be replaced by t.Setenv\(\) in TestDefaults$`
	})
}

func BenchmarkUnnamed(*testing.B) {
	os.Setenv("A", "b") // want `^os.Setenv\(\) could be replaced by <t/b>.Setenv\(\) in BenchmarkUnnamed$`
}

func helper(tb testing.TB) {
	os.Setenv("A", "b") // want `^os.Setenv\(\) could be replaced by tb.Setenv\(\) in helper$`
}

var _ = func(t *testing.T) {
	os.Setenv("A", "b") // want `^os.Setenv\(\) could be replaced by t.Setenv\(\) in anonymous function$`
}

func notTest() {
	os.Setenv("A", "b")
}
