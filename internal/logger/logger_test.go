package logger_test

import (
	"bytes"
	"log/slog"
	"testing"

	"github.com/alecthomas/assert/v2"
	"github.com/alecthomas/kong"

	"github.com/alecthomas/tsktsk/internal/logger"
)

func TestKongConfig(t *testing.T) {
	for _, test := range []struct {
		name  string
		args  []string
		level slog.Level
	}{
		{name: "Default", level: slog.LevelError},
		{name: "Debug", args: []string{"--log-level=debug"}, level: slog.LevelDebug},
		{name: "Info", args: []string{"--log-level=info"}, level: slog.LevelInfo},
	} {
		t.Run(test.name, func(t *testing.T) {
			var config logger.Config
			parser, err := kong.New(&config)
			assert.NoError(t, err)
			_, err = parser.Parse(test.args)
			assert.NoError(t, err)
			assert.Equal(t, logger.Config{Level: test.level}, config)
		})
	}
}

func TestKongRejectsInvalidLevel(t *testing.T) {
	var config logger.Config
	parser, err := kong.New(&config)
	assert.NoError(t, err)
	_, err = parser.Parse([]string{"--log-level=invalid"})
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "--log-level")
}

func TestOutputRespectsLevel(t *testing.T) {
	var output bytes.Buffer
	log := logger.New(logger.Config{Level: slog.LevelWarn}, &output)
	log.Info("hidden")
	log.Warn("shown", "key", "value")
	assert.NotContains(t, output.String(), "hidden")
	assert.Contains(t, output.String(), "shown")
	assert.Contains(t, output.String(), "key=value")
	assert.NotContains(t, output.String(), "\x1b[", "no colour when output is not a terminal")
	assert.Equal(t, "WRN shown key=value\n", output.String(), "no timestamp")
}
