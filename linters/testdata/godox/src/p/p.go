package p

/* TODO: tidy this up */ // want `^Line contains TODO/BUG/FIXME: "TODO: tidy this up"$`
func f() {}

/* BUG: a line longer than forty bytes is truncated */ // want `^Line contains TODO/BUG/FIXME: "BUG: a line longer than forty bytes is t\.\.\."$`
func long() {}

// TODOS are not keywords.
func g() {}

/* fixme later */ // want `^Line contains TODO/BUG/FIXME: "fixme later"$`
func h() {}
