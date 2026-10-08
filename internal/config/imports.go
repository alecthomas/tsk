package config

import (
	"strconv"
	"strings"

	"github.com/alecthomas/errors"
	"github.com/pelletier/go-toml/v2/unstable"

	"github.com/alecthomas/tsk/internal/library"
)

// SetImports returns config file text with the imports setting replaced by
// imports, keeping everything else, including comments, as written. Without
// an imports setting, it is added at the top, where top-level settings belong.
func SetImports(text []byte, imports []library.Import) ([]byte, error) {
	var setting strings.Builder
	setting.WriteString("imports = [\n")
	for _, imported := range imports {
		// Import strings are ASCII without quotes or escapes, as Go quotes them.
		setting.WriteString("  " + strconv.Quote(imported.String()) + ",\n")
	}
	setting.WriteString("]")
	parser := unstable.Parser{}
	parser.Reset(text)
	for parser.NextExpression() {
		expression := parser.Expression()
		if expression.Kind == unstable.Table || expression.Kind == unstable.ArrayTable {
			break
		}
		if expression.Kind != unstable.KeyValue || !isKey(expression, "imports") {
			continue
		}
		start, end := expression.Raw.Offset, expression.Raw.Offset+expression.Raw.Length
		return []byte(string(text[:start]) + setting.String() + string(text[end:])), nil
	}
	if err := parser.Error(); err != nil {
		return nil, errors.Wrap(err, "parse config")
	}
	if len(text) == 0 {
		return []byte(setting.String() + "\n"), nil
	}
	return []byte(setting.String() + "\n\n" + string(text)), nil
}

// isKey reports whether a key-value expression has the undotted key name.
func isKey(expression *unstable.Node, name string) bool {
	key := expression.Key()
	return key.Next() && string(key.Node().Data) == name && key.IsLast()
}
