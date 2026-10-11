package c

import "encoding/json"

//go:fix inline
func OldProcess(m json.Marshaler) error { // want OldProcess:`goFixInline {"name":"c.OldProcess"`
	return NewProcess(m)
}

func NewProcess(m json.Marshaler) error {
	_, err := m.MarshalJSON()
	return err
}

