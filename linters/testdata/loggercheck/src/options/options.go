// Adapted from github.com/timonwong/loggercheck's tests, MIT License.
package options

import "log/slog"

type Logger struct{}

func (*Logger) Infow(msg string, keysAndValues ...any) {}

func (*Logger) Debugw(msg string, keysAndValues ...any) {}

func _(logger *Logger, key string) {
	logger.Infow("message", "key")                     // want "odd number of arguments"
	logger.Debugw("message", "key")
	slog.Info("message", key, 1)                       // want `^logging keys are expected to be inlined constant strings, please replace "key" provided with string$`
	slog.Info("message", "ключ", 1)                    // want `^logging keys are expected to be alphanumeric strings, please remove any non-latin characters from "ключ"$`
	slog.Info("message", func() string { return "a" }(), 1) // want `please replace "func\(\) string { r\.\.\." provided`
	slog.Info("message %d", "key", 1)                  // want `^logging message should not use format specifier "%d"$`
	slog.Info("100%", "key", 1)
}
