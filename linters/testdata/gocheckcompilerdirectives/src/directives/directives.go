package directives

//go:generate echo ok

// go:generate echo spaced // want `^compiler directive contains space: // go:generate$`

//go:noinlne because // want `^compiler directive unrecognized: //go:noinlne$`

//  go:bogus x // want `compiler directive contains space: //  go:bogus` `compiler directive unrecognized: //  go:bogus`

//go:noinline
func f() {}

//go:unknownbutlast
func g() {}
