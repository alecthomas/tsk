package configured

type Node interface{ node() } // want Node:`sumType \{"variants":\["A","B"\]\}`

type A struct{}

func (*A) node() {}
func (*A) both() {}

type B struct{}

func (*B) node() {}

//sumtype:decl
type Both interface{ both() } // want Both:`sumType \{"variants":\["A"\]\}`

type Unlisted interface{ unlisted() }

func (*B) unlisted() {}

func unlisted(u Unlisted) {
	switch u.(type) {
	}
}
