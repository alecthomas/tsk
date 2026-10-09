package reject

import "io"

type Doer interface{ Do() }

func NewDoer() Doer { return nil }

func Reader() io.Reader { return nil } // want `^Reader returns interface \(io.Reader\)$`
