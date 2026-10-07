package facts_test

import (
	"testing"

	"github.com/alecthomas/assert/v2"
	"golang.org/x/tools/go/analysis"

	"github.com/alecthomas/tsktsk/internal/facts"
)

func TestTypesAreValidDistinctFacts(t *testing.T) {
	types, err := facts.Types(2)
	assert.NoError(t, err)
	assert.NotEqual(t, types[0], types[1])
	analyzer := &analysis.Analyzer{
		Name:      "x",
		Doc:       "x",
		Run:       func(*analysis.Pass) (any, error) { return nil, nil }, //nolint:nilnil // The analyzer has no result.
		FactTypes: []analysis.Fact{facts.New(types[0]), facts.New(types[1])},
	}
	assert.NoError(t, analysis.Validate([]*analysis.Analyzer{analyzer}))
}

func TestTooMany(t *testing.T) {
	_, err := facts.Types(1000)
	assert.EqualError(t, err, "1000 facts declared; at most 256 are supported")
}
