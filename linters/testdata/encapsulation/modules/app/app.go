package app

import (
	"example.com/app/local"
	"example.com/lib"
)

func use() {
	_ = lib.Hidden{}
	_ = new(lib.Hidden)
	_ = local.Hidden{} // want "encapsulated struct example.com/app/local.Hidden may only be constructed"
}
