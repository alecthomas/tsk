// Package linters holds the linter scripts compiled into tsk.
package linters

import "embed"

// Scripts are the compiled-in linter scripts.
//
//go:embed *.ts
var Scripts embed.FS
