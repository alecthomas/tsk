package fixture

func testsPassNil() {
	use(nil)
	for _, input := range map[string]*value{"Nil": nil} {
		use(input)
	}
}
