// Adapted from github.com/mgechev/revive's tests, MIT License.

// Package marshalreceiver tests marshal-receiver.
package marshalreceiver

import "encoding/json"

// Good: MarshalJSON with value receiver.
type GoodMarshalRecv struct{}

func (GoodMarshalRecv) MarshalJSON() ([]byte, error)          { return json.Marshal(nil) }
func (*GoodMarshalRecv) UnmarshalJSON([]byte) error           { return nil }
func (GoodMarshalRecv) MarshalText() (text []byte, err error) { return nil, nil }
func (*GoodMarshalRecv) UnmarshalText([]byte) error           { return nil }
func (GoodMarshalRecv) MarshalYAML() (any, error)             { var v any; return v, nil }
func (*GoodMarshalRecv) UnmarshalYAML(func(any) error) error  { return nil }

// Bad: MarshalJSON with pointer receiver.
type BadMarshalRecv struct{}

func (*BadMarshalRecv) MarshalJSON() ([]byte, error)          { return json.Marshal(nil) } // want "^marshal-receiver: BadMarshalRecv.MarshalJSON method should use a value receiver, not a pointer receiver$"
func (BadMarshalRecv) UnmarshalJSON([]byte) error             { return nil }               // want "^marshal-receiver: BadMarshalRecv.UnmarshalJSON method should use a pointer receiver, not a value receiver$"
func (*BadMarshalRecv) MarshalText() (text []byte, err error) { return nil, nil }          // want "^marshal-receiver: BadMarshalRecv.MarshalText method should use a value receiver, not a pointer receiver$"
func (BadMarshalRecv) UnmarshalText([]byte) error             { return nil }               // want "^marshal-receiver: BadMarshalRecv.UnmarshalText method should use a pointer receiver, not a value receiver$"
func (*BadMarshalRecv) MarshalYAML() (any, error)             { var v any; return v, nil } // want "^marshal-receiver: BadMarshalRecv.MarshalYAML method should use a value receiver, not a pointer receiver$"
func (BadMarshalRecv) UnmarshalYAML(func(any) error) error    { return nil }               // want "^marshal-receiver: BadMarshalRecv.UnmarshalYAML method should use a pointer receiver, not a value receiver$"

type Generic[T any] struct{}

func (*Generic[T]) MarshalText() ([]byte, error) { return nil, nil } // want "^marshal-receiver: Generic.MarshalText method should use a value receiver, not a pointer receiver$"
