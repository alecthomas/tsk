package use

import (
	"enums"
	"reflect"
)

func switches(d enums.Direction, s enums.Shape, i enums.Ignored, k reflect.Kind) {
	switch d { // want "^missing cases in switch of type enums.Direction: enums.South, enums.West$"
	case enums.North, enums.East:
	}

	// Unexported members of other packages need no case.
	switch d {
	case enums.North, enums.East, enums.South, enums.West:
	}

	switch d { // want "^missing cases in switch of type enums.Direction: enums.East, enums.South, enums.West$"
	case enums.North:
	default:
	}

	//exhaustive:ignore
	switch d {
	case enums.North:
	}

	switch s {
	case enums.Round, enums.Square:
	}

	switch i {
	case enums.IgnoredA:
	}

	switch k { // want "^missing cases in switch of type reflect.Kind: reflect.Invalid, "
	case reflect.Bool:
	}

	//exhaustive:bogus
	switch d { // want `failed to parse directives: invalid directive "bogus"` "^missing cases in switch"
	}
}

var names = map[enums.Direction]string{
	enums.North: "north",
}

func generic[T enums.Direction | enums.Level](t T) {
	switch t { // want "^missing cases in switch of type enums.Direction\\|enums.Level: enums.South, enums.West, enums.High$"
	case T(enums.North), T(enums.East), T(enums.Low):
	}
}
