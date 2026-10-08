// Package pb mimics a generated protobuf package.
package pb

type Msg struct {
	Name     string
	Count    *int32
	Child    *Msg
	Children []*Msg
}

func (*Msg) ProtoReflect() {}

func (m *Msg) GetName() string {
	if m == nil {
		return ""
	}
	return m.Name
}

func (m *Msg) GetCount() int32 {
	if m == nil || m.Count == nil {
		return 0
	}
	return *m.Count
}

func (m *Msg) GetChild() *Msg {
	if m == nil {
		return nil
	}
	return m.Child
}

func (m *Msg) GetChildren() []*Msg {
	if m == nil {
		return nil
	}
	return m.Children
}
