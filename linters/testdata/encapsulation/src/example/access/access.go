package access

type Access struct{ hidden int } // want Access:`encapsulated \{"directConstructor":false,"generated":false,"module":""\}`
func (*Access) Touch()           {}

type ReadOnly struct { // want ReadOnly:`encapsulated \{"directConstructor":false,"generated":false,"module":""\}`
	hidden int
	items  []int
	table  map[int]int
}

func (*ReadOnly) Touch() {}

type WriteOnly struct { // want WriteOnly:`encapsulated \{"directConstructor":false,"generated":false,"module":""\}`
	hidden int
	items  []int
	table  map[int]int
}

func (*WriteOnly) Touch() {}

type Denied struct{ hidden int } // want Denied:`encapsulated \{"directConstructor":false,"generated":false,"module":""\}`
func (*Denied) Touch()           {}

type Combined struct{ hidden []int } // want Combined:`encapsulated \{"directConstructor":false,"generated":false,"module":""\}`
func (*Combined) Touch()             {}

type Worker struct{}

func (Worker) exercise(a *Access, r *ReadOnly, w *WriteOnly, d *Denied) {
	_ = a.hidden
	a.hidden = 1
	a.hidden++
	a.hidden += 2

	_ = r.hidden
	r.hidden = r.hidden // want "private field example/access.ReadOnly.hidden"
	r.hidden++          // want "private field example/access.ReadOnly.hidden"
	_ = &r.hidden       // want "private field example/access.ReadOnly.hidden"

	w.hidden = 1
	w.hidden++
	w.hidden = w.hidden // want "private field example/access.WriteOnly.hidden"
	_ = w.hidden        // want "private field example/access.WriteOnly.hidden"
	_ = &w.hidden

	_ = d.hidden // want "private field example/access.Denied.hidden"
	d.hidden = 1 // want "private field example/access.Denied.hidden"

	values := make([]int, 3)
	values[w.hidden] = 1          // want "private field example/access.WriteOnly.hidden"
	for r.hidden = range values { // want "private field example/access.ReadOnly.hidden"
	}
	for w.hidden = range values {
	}
	w.items[0] = 1
	r.items[0] = 1 // want "private field example/access.ReadOnly.items"
	copy(w.items, values)
	copy(r.items, values) // want "private field example/access.ReadOnly.items"
	clear(w.table)
	delete(r.table, 0) // want "private field example/access.ReadOnly.table"
}

func (Worker) update(c *Combined) {
	c.hidden = append(c.hidden, 1)
}

func permittedHelper(r *ReadOnly) { _ = r.hidden }

func outsider(a *Access, r *ReadOnly, w *WriteOnly, c *Combined) {
	_ = a.hidden
	a.hidden = 1
	_ = r.hidden                   // want "private field example/access.ReadOnly.hidden"
	w.hidden = 1                   // want "private field example/access.WriteOnly.hidden"
	c.hidden = append(c.hidden, 1) // want "private field example/access.Combined.hidden" "private field example/access.Combined.hidden"
}
