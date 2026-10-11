package main

import (
	"example.com/lib"
	"example.com/other"
)

func _() {
	var _ lib.Alias[other.Other] // want "Type alias lib.Alias.other.Other. should be inlined"
}
