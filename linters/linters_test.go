package linters_test

import (
	"context"
	"log/slog"
	"testing"

	"github.com/alecthomas/assert/v2"

	"github.com/alecthomas/tsk/internal/compile"
	"github.com/alecthomas/tsk/internal/engine"
	"github.com/alecthomas/tsk/internal/scripttest"
	"github.com/alecthomas/tsk/linters"
)

func TestLinters(t *testing.T) {
	e, err := engine.Load(context.Background(), slog.New(slog.DiscardHandler), []compile.Source{{Name: "builtin", FS: linters.Scripts}})
	assert.NoError(t, err)
	for _, analyzer := range e.Names() {
		dir := scripttest.Dir(".", analyzer)
		cases, err := scripttest.Cases(dir)
		assert.NoError(t, err)
		for _, c := range cases {
			t.Run(analyzer+"/"+c.Name, func(t *testing.T) {
				assert.NoError(t, scripttest.Run(t, e, analyzer, dir, c))
			})
		}
	}
}
