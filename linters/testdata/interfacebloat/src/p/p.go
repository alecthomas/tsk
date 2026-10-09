package p

import "io"

type Small interface {
	io.Reader
	Close() error
}

type Large interface { // want `^the interface has more than 2 methods: 3$`
	io.Reader
	Close() error
	Flush() error
}
