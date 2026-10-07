package bindgen

import (
	"go/types"
	"strconv"
	"strings"

	"github.com/alecthomas/tsktsk/internal/naming"
)

// unknownType stands for Go types scripts can hold but not inspect.
const unknownType = "unknown"

func basicType(t *types.Basic) string {
	info := t.Info()
	switch {
	case info&types.IsBoolean != 0:
		return "boolean"
	case info&types.IsString != 0:
		return "string"
	case info&types.IsComplex != 0:
		return unknownType
	case info&types.IsNumeric != 0:
		return "number"
	case t.Kind() == types.UntypedNil:
		return "null"
	}
	return unknownType
}

func wrapUnion(text string) string {
	if strings.Contains(text, "|") || strings.Contains(text, "=>") {
		return "(" + text + ")"
	}
	return text
}

func variadicPrefix(variadic bool) string {
	if variadic {
		return "..."
	}
	return ""
}

func isError(t types.Type) bool {
	return types.Identical(t, types.Universe.Lookup("error").Type())
}

func isBool(t types.Type) bool {
	basic, ok := t.(*types.Basic)
	return ok && basic.Kind() == types.Bool
}

func parameterName(name string, index int) string {
	if name == "" || name == "_" || strings.HasPrefix(name, "#") {
		return "arg" + strconv.Itoa(index)
	}
	return naming.Identifier(name)
}
