// Package typescript re-exports the parts of the TypeScript 7 compiler that
// tsk needs. Its module path permits importing their internal packages.
package typescript

import (
	"fmt"
	"strings"

	"github.com/microsoft/TypeScript/tsc/internal/ast"
	"github.com/microsoft/TypeScript/tsc/internal/checker"
	"github.com/microsoft/TypeScript/tsc/internal/scanner"
)

// Type is a resolved TypeScript type, valid only with the program that made it.
type Type = checker.Type

// Call is one call of a declared function found in a script.
type Call struct {
	// Offset is where an inserted first argument belongs: just after "(".
	Offset int
	// HasArguments reports whether the call already has arguments.
	HasArguments bool
	// TypeArguments are the call's explicit type arguments.
	TypeArguments []*Type
	// Location is the call's file:line:column.
	Location string
}

// location formats a node's first token as file:line:column, with the file
// name relative to the program root.
func location(node *ast.Node) string {
	file := ast.GetSourceFileOfNode(node)
	if file == nil {
		return "<unknown>"
	}
	line, column := scanner.GetECMALineAndUTF16CharacterOfPosition(file, scanner.GetTokenPosOfNode(node, file, false))
	return fmt.Sprintf("%s:%d:%d", strings.TrimPrefix(file.FileName(), "/"), line+1, int(column)+1)
}
