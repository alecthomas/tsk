package maps

import "enums"

var names = map[enums.Direction]string{ // want "^missing keys in map of key type enums.Direction: enums.East, enums.South, enums.West$"
	enums.North: "north",
}

//exhaustive:ignore
var ignored = map[enums.Direction]string{
	enums.North: "north",
}

var empty = map[enums.Direction]string{}

func defaulted(d enums.Direction) {
	switch d {
	case enums.North:
	default:
	}
}
