package dep

import "sync"

type Shared struct {
	Mu    sync.Mutex
	Value int // want Value:`guardedBy \{"lock":"Mu"\}`
}
