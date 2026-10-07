// Package logger configures structured logging.
package logger

import (
	"io"
	"log/slog"
	"os"

	"github.com/lmittmann/tint"
	"golang.org/x/term"
)

// Config contains logging flags that can be embedded in a Kong CLI.
type Config struct {
	// Level is the minimum severity written to the log. Linting output is the
	// diagnostics, so logs are quiet unless asked for.
	Level slog.Level `name:"log-level" default:"error" help:"Minimum log level (debug, info, warn, error)."`
}

// New constructs a logger that writes to output. Colour is used only when
// output is a terminal.
func New(config Config, output io.Writer) *slog.Logger {
	file, isFile := output.(*os.File)
	return slog.New(tint.NewTextHandler(output, &tint.Options{
		Level:   config.Level,
		NoColor: !isFile || !term.IsTerminal(int(file.Fd())),
		ReplaceAttr: func(groups []string, attr slog.Attr) slog.Attr {
			if len(groups) == 0 && attr.Key == slog.TimeKey {
				return slog.Attr{}
			}
			return attr
		},
	}))
}
