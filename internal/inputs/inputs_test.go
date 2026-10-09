package inputs_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/alecthomas/assert/v2"

	"github.com/alecthomas/tsk/internal/inputs"
)

func TestRecorder(t *testing.T) {
	dir := t.TempDir()
	note := filepath.Join(dir, "note.txt")
	assert.NoError(t, os.WriteFile(note, []byte("one"), 0o600))

	recorder := inputs.NewRecorder()
	data, err := recorder.For("a").ReadFile(note)
	assert.NoError(t, err)
	assert.Equal(t, "one", string(data))
	_, err = recorder.For("b").Stat(filepath.Join(dir, "missing"))
	assert.True(t, os.IsNotExist(err))

	// A run keeps its first view of a file.
	assert.NoError(t, os.WriteFile(note, []byte("two"), 0o600))
	data, err = recorder.For("b").ReadFile(note)
	assert.NoError(t, err)
	assert.Equal(t, "one", string(data))

	observations := recorder.Observations([]string{"a"})
	assert.Equal(t, 1, len(observations))
	assert.Equal(t, inputs.Call{Func: "os.ReadFile", Args: `["` + note + `"]`}, observations[0].Call)
	assert.Equal(t, 2, len(recorder.Observations([]string{"b"})))

	// A later run sees the change, but not a missing file still missing.
	later := inputs.NewRecorder()
	assert.False(t, later.Valid(observations))
	missing := recorder.Observations([]string{"b"})[1]
	assert.Equal(t, "os.Stat", missing.Call.Func)
	assert.True(t, later.Valid([]inputs.Observation{missing}))
	assert.NoError(t, os.WriteFile(note, []byte("one"), 0o600))
	assert.True(t, inputs.NewRecorder().Valid(observations))
}

// A cache written by another version may record calls this one cannot make.
func TestValidRejectsUnknownCalls(t *testing.T) {
	recorder := inputs.NewRecorder()
	for _, call := range []inputs.Call{
		{Func: "os.Remove", Args: `["x"]`},
		{Func: "os.ReadFile", Args: `[]`},
		{Func: "os.ReadFile", Args: `not json`},
	} {
		assert.False(t, recorder.Valid([]inputs.Observation{{Call: call}}), "%v", call)
	}
}
