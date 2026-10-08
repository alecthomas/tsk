package idents

import fmtа "fmt" // want `identifier "fmtа" contain non-ASCII character: U\+0430 'а'`

type Tуpe struct { // want `identifier "Tуpe" contain non-ASCII character: U\+0443 'у'`
	Fiеld int // want `identifier "Fiеld" contain non-ASCII character: U\+0435 'е'`
}

type Gеneric[Tа any] struct{} // want `identifier "Gеneric"` `identifier "Tа"`

type Iface interface {
	Mеthod(аrg int) (rеsult int) // want `identifier "Mеthod"` `identifier "аrg"` `identifier "rеsult"`
}

const Cоnst = 1 // want `identifier "Cоnst"`

var vаr = 2 // want `identifier "vаr"`

func (rеcv Tуpe) Func(pаram int) { // want `identifier "rеcv"` `identifier "pаram"`
	lоcal := 3 // want `identifier "lоcal"`
	_ = lоcal
lаbel: // want `identifier "lаbel"`
	for {
		break lаbel
	}
}

func Fünc() { // want `identifier "Fünc" contain non-ASCII character: U\+00FC 'ü'`
	fmtа.Println(vаr, Cоnst)
	plain := 1
	plain = 2
	_ = plain
}
