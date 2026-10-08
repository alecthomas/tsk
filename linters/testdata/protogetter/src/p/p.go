// Adapted from github.com/ghostiam/protogetter's tests, MIT License.
package p

import "pb"

func use(...any) {}

func optional(*int32) {}

func _(m *pb.Msg) {
	_ = m.Name              // want "^avoid direct access to proto field m.Name, use m.GetName\\(\\) instead$"
	_ = m.Child.Name        // want "avoid direct access to proto field m.Child.Name, use m.GetChild\\(\\).GetName\\(\\) instead"
	_ = *m.Count            // want "avoid direct access to proto field \\*m.Count, use m.GetCount\\(\\) instead"
	use(m.Children[0].Name) // want "use m.GetChildren\\(\\)\\[0\\].GetName\\(\\) instead"
	_ = m.GetName()
	m.Name = "x"
	_ = &m.Name
	optional(m.Count)
	m.Children = append(m.Children, nil)
	if m.Child != nil { // want "use m.GetChild\\(\\) instead"
		return
	}
}
