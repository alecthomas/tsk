// Adapted from github.com/mgechev/revive's tests, MIT License.

// Test of stuttery names.

// Package donut ...
package donut

// DonutMaker makes donuts.
type DonutMaker struct{} // want "^exported: type name will be used as donut.DonutMaker by other packages, and that stutters; consider calling this Maker$"

// DonutRank computes the ranking of a donut.
func DonutRank(d Donut) int { // want "^exported: func name will be used as donut.DonutRank by other packages, and that stutters; consider calling this Rank$"
	return 0
}

// Donut is a delicious treat.
type Donut struct{} // ok because it is the whole name

// Donuts are great, aren't they?
type Donuts []Donut // ok because it didn't start a new word

type donutGlaze int // ok because it is unexported

// DonutMass reports the mass of a donut.
func (d *Donut) DonutMass() (grams int) { // okay because it is a method
	return 38
}

// Donut_Hole is a name that starts a new word with an underscore.
type Donut_Hole struct{} // want "^exported: type name will be used as donut.Donut_Hole by other packages, and that stutters; consider calling this _Hole$"
