package a

import "io"

//go:fix inline
func OldHello(w io.Writer) error { // want OldHello:`goFixInline {"name":"a.OldHello"`
	return NewHello(w)
}

func NewHello(w io.Writer) error {
	_, err := w.Write([]byte("Hello, World!"))
	return err
}

