package typed

import (
	stderrors "errors"
	"fmt"
	"strings"
)

func Errors() error {
	_ = stderrors.New("x") // want "^use of `stderrors.New` forbidden because \"use github.com/alecthomas/errors instead\"$"
	var b strings.Builder
	b.WriteString("x") // want "^use of `b.WriteString` forbidden because \"no builders\"$"
	return fmt.Errorf("x") // want "^use of `fmt.Errorf` forbidden by pattern"
}
