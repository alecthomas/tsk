// Adapted from github.com/mgechev/revive's tests, MIT License.

package fixtures

import (
	"bytes"
	"crypto/md5"
	"fixtures" // Test case for issue #534
	"fmt"
	ast "go/ast"
	_ "net/http"
	"strings"
	str "strings"
)

const str = "" // want "^import-shadowing: The name 'str' shadows an import name$"

type myAst struct {
	ast *ast.GenDecl
}

type bytes struct{} // want "^import-shadowing: The name 'bytes' shadows an import name$"

type fmt interface{} // want "^import-shadowing: The name 'fmt' shadows an import name$"

func (ast myAst) foo() {} // want "^import-shadowing: The name 'ast' shadows an import name$"

func (a myAst) fmt() { // this should be skipped (method, not a pkg func)
	var fmt string // want "^import-shadowing: The name 'fmt' shadows an import name$"
}

func (a myAst) md5() { // this should be skipped (method, not a pkg func)
	strings := map[string]string{} // want "^import-shadowing: The name 'strings' shadows an import name$"
}

func md5() {} // want "^import-shadowing: The name 'md5' shadows an import name$"

func bar(_ string) {}

func toto() {
	strings := map[string]string{} // want "^import-shadowing: The name 'strings' shadows an import name$"
}

func titi() {
	v := md5 + bytes
	return ast
}
