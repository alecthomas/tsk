// Adapted from github.com/raeperd/recvcheck's tests, MIT License.
package decoders

type Decoder struct{} // want `the methods of "Decoder" use pointer receiver and non-pointer receiver\.`

func (d Decoder) String() string             { return "" }
func (d *Decoder) UnmarshalJSON([]byte) error { return nil }
