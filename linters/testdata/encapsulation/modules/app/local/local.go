package local

type Hidden struct { // want Hidden:`encapsulated \{"directConstructor":false,"generated":false,"module":"example.com/app"\}`
	private int
}

func (h *Hidden) Private() int { return h.private }
