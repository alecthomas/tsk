package naming_test

import (
	"testing"

	"github.com/alecthomas/assert/v2"

	"github.com/alecthomas/tsk/internal/naming"
)

func TestMember(t *testing.T) {
	for _, test := range []struct{ Go, JS string }{
		{"IsNil", "isNil"},
		{"X", "x"},
		{"URL", "url"},
		{"ASTNode", "astNode"},
		{"ObjectOf", "objectOf"},
		{"TypesInfo", "typesInfo"},
		{"ID2", "id2"},
	} {
		assert.Equal(t, test.JS, naming.Member(test.Go))
	}
}

func TestKebab(t *testing.T) {
	for _, test := range []struct{ Name, Key, Error string }{
		{Name: "allowReads", Key: "allow-reads"},
		{Name: "allowGeneratedConstruction", Key: "allow-generated-construction"},
		{Name: "allowURL", Key: "allow-u-r-l"},
		{Name: "limit", Key: "limit"},
		{Name: "allow_reads", Error: `property name "allow_reads" cannot map to a TOML key; use lowerCamelCase`},
	} {
		key, err := naming.Kebab(test.Name)
		if test.Error != "" {
			assert.EqualError(t, err, test.Error)
			continue
		}
		assert.NoError(t, err)
		assert.Equal(t, test.Key, key)
	}
}
