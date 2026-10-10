// Adapted from github.com/mgechev/revive's tests, MIT License.
package statements

import (
	"fmt"
	ast "go/ast"
)

func funLengthA() { // want "^function-length: maximum number of statements per function exceeded; max 2 but got 5$"
	println()
	println()
	println()
	println()
	println()
}

type Message struct{}

func funLengthB(a, b, c, d int, list []any) []Message { // want "^function-length: maximum number of statements per function exceeded; max 2 but got 14$"
	if true {
		a = b
		if false {
			c = d
			for _, f := range list {
				_, ok := f.(int64)
				if !ok {
					continue
				}
			}
			switch a {
			case 1:
				println()
			case 2:
				println()
				println()
			default:
				println()

			}
		}
	}
	return nil
}

type counter struct{}

func (counter) countStmts([]ast.Stmt) int { return 0 }

func (counter) countBodyListStmts(ast.Stmt) int { return 0 }

func (counter) countFuncLitStmts(ast.Expr) int { return 0 }

func (w counter) funLengthC(b []ast.Stmt) int { // want "^function-length: maximum number of statements per function exceeded; max 2 but got 12$"
	count := 0
	for _, s := range b {
		switch stmt := s.(type) {
		case *ast.BlockStmt:
			count += w.countStmts(stmt.List)
		case *ast.ForStmt, *ast.RangeStmt, *ast.IfStmt,
			*ast.SwitchStmt, *ast.TypeSwitchStmt, *ast.SelectStmt:
			count += 1 + w.countBodyListStmts(stmt)
		case *ast.CaseClause:
			count += w.countStmts(stmt.Body)
		case *ast.AssignStmt:
			count += 1 + w.countFuncLitStmts(stmt.Rhs[0])
		case *ast.GoStmt:
			count += 1 + w.countFuncLitStmts(stmt.Call.Fun)
		case *ast.DeferStmt:
			count += 1 + w.countFuncLitStmts(stmt.Call.Fun)
		default:
			fmt.Printf("%T %v\n", stmt, stmt)
			count++
		}
	}

	return count
}

func funLengthD() {
	defer func() { println() }()
}

func funLengthE() { // want "^function-length: maximum number of statements per function exceeded; max 2 but got 4$"
	defer func() {
		if true {
			println()
		} else {
			print()
		}
	}()
}

// Revive stops checking a file at an empty function; this port does not.
func empty() {}

func funLengthF() { // want "^function-length: maximum number of statements per function exceeded; max 2 but got 3$"
	if true {
		println()
	} else {
		print()
	}
}

func funLengthG() { // want "^function-length: maximum number of statements per function exceeded; max 2 but got 3$"
	go func() {
		if true {
			println()
		} else {

		}
	}()
}

func funLengthH() {
	go func() {}()
	println()
}

func elseIf(x int) { // want "^function-length: maximum number of statements per function exceeded; max 2 but got 3$"
	if x > 0 {
		println()
	} else if x < 0 {
		println()
		println()
	}
L:
	for {
		break L
	}
}
