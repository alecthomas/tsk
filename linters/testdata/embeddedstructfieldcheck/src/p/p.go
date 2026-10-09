package p

import (
	"io"
	"sync"
)

type separated struct {
	io.Reader

	name string
}

type adjacent struct {
	io.Reader // want `^there must be an empty line separating embedded fields from regular fields$`
	name      string
}

type misplaced struct {
	name      string
	io.Reader // want `^embedded fields should be listed before regular fields$`
}

type mutex struct {
	sync.Mutex

	name string
}
