package allaccess

type widget struct{ hidden int }

func (*widget) Touch() {}

func use(w *widget) {
	_ = w.hidden
	w.hidden = 1
	w.hidden++
}
