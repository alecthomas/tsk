package options

import (
	"io"
	"sync"
)

type adjacent struct {
	io.Reader
	name string
}

type mutex struct {
	sync.Mutex     // want `^sync.Mutex should not be embedded$`
	*sync.RWMutex  // want `^sync.RWMutex should not be embedded$`
}
