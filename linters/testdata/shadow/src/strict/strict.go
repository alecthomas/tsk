package strict

func unusedAfter() {
	x := 1
	_ = x
	{
		x := 2 // want "declaration of .x. shadows declaration at line 4"
		_ = x
	}
}

func differentType() {
	x := 1
	_ = x
	{
		x := "s"
		_ = x
	}
}
