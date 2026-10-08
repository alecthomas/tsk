// Adapted from github.com/timonwong/loggercheck's tests, MIT License.
package basic

import "log/slog"

type name struct{}

func (*name) String() string { return "" }

type value struct{}

func (value) String() string { return "" }

func _(logger *slog.Logger, n *name, v *value) {
	slog.Info("message", "key", "value")
	slog.Info("message", "key") // want "^odd number of arguments passed as key-value pairs for logging$"
	logger.Error("message", "a", 1, "b")                // want "odd number of arguments"
	logger.With("key")                                  // want "odd number of arguments"
	slog.Info("message", slog.String("key", "value"), "key", "value")
	slog.Info("message", slog.Group("group", "key"))    // want "odd number of arguments"
	slog.Info("message", "name", n)
	slog.Info("message", "value", v) // want "^logging value may panic when nil because its element type implements fmt.Stringer$"
	args := []any{"key"}
	slog.Info("message", args...)
}
