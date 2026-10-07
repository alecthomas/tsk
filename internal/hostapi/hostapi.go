// Package hostapi holds the hand-written "tsk" script modules and their
// TypeScript declarations.
package hostapi

import _ "embed"

// Declaration declares the "tsk" and "tsk/passes" modules.
//
//go:embed tsk.d.ts
var Declaration string

// Tsk is the JavaScript source of the "tsk" module.
//
//go:embed tsk.js
var Tsk string

// Passes is the JavaScript source of the "tsk/passes" module.
//
//go:embed passes.js
var Passes string
