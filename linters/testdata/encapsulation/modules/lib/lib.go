package lib

type Hidden struct {
	private int
}

func (h *Hidden) Private() int { return h.private }
