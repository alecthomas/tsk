package p

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

func external() error {
	_, err := json.Marshal(1)
	return err // want `^error returned from external package is unwrapped: sig: func encoding/json.Marshal\(v any\) \(\[\]byte, error\)$`
}

func direct(r io.Reader) error {
	return json.NewDecoder(r).Decode(nil) // want `^error returned from external package is unwrapped: sig: func \(\*encoding/json.Decoder\).Decode\(v any\) error$`
}

func viaInterface(r io.Reader) error {
	_, err := r.Read(nil)
	return err // want `^error returned from interface method should be wrapped: sig: func \(io.Reader\).Read\(p \[\]byte\) \(n int, err error\)$`
}

func wrapped() error {
	_, err := json.Marshal(1)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	return errors.New("done")
}

func internal() error {
	return local()
}

func local() error { return nil }

func anonymous() func() error {
	return func() error {
		return json.Unmarshal(nil, nil)
	}
}
