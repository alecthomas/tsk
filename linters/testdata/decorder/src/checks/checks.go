package checks

type t int

func f() {
	const local = 1
	_ = local
}

const a = 1 // want `^const must not be placed after func \(desired order: type,const,var,func\)$`

const b = 2 // want `^multiple "const" declarations are not allowed; use parentheses instead$` `^const must not be placed after func \(desired order: type,const,var,func\)$`

func init() {} // want `^init func must be the first function in file$`
