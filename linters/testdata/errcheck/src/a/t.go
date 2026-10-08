// This file exists so that we can check that multi-file packages work
package a

import "fmt"

type t struct{}

func (x t) a() error {
	fmt.Println("this method returns an error") // EXCLUDED
	return nil
}

type u struct {
	t t
}

type embedt struct {
	t
}

type embedtalias = embedt

type embedtptralias = *embedt

func (x t) b() {
	x.a() // want "^Error return value of `x.a` is not checked$"
}
