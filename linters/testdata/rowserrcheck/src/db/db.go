// Package db stands in for a database library such as sqlx.
package db

type Conn struct{}

type Rows struct{}

func (*Conn) Query() *Rows { return &Rows{} }

func (*Rows) Next() bool  { return false }
func (*Rows) Err() error  { return nil }
func (*Rows) Close() error { return nil }
