// Adapted from github.com/mgechev/revive's tests, MIT License.

// Test of empty-lines.

package fixtures

import "time"

func f1(x int) bool { // want "^empty-lines: extra empty line at the start of a block$"

	return x > 2
}

func f2(x int) bool { // want "^empty-lines: extra empty line at the end of a block$"
	return x > 2

}

func f3(x int) bool { // want "^empty-lines: extra empty line at the start of a block$" "^empty-lines: extra empty line at the end of a block$"

	return x > 2

}

func f4(x int) bool {
	// This is fine.
	return x > 2
}

func f5(x int) bool { // want "^empty-lines: extra empty line at the start of a block$"

	// This is _not_ fine.
	return x > 2
}

func f6(x int) bool {
	return x > 2
	// This is fine.
}

func f7(x int) bool { // want "^empty-lines: extra empty line at the end of a block$"
	return x > 2
	// This is _not_ fine.

}

func f8(x int) bool {
	if x > 2 { // want "^empty-lines: extra empty line at the start of a block$"

		return true
	}

	return false
}

func f9(x int) bool {
	if x > 2 { // want "^empty-lines: extra empty line at the end of a block$"
		return true

	}

	return false
}

func f10(x int) bool { // want "^empty-lines: extra empty line at the start of a block$"

	if x > 2 {
		return true
	}

	return false
}

func f11(x int) {
	if x > 2 {
		return
	}
}

func f12(x int) { // want "^empty-lines: extra empty line at the end of a block$"
	if x > 2 {
		return
	}

}

func f13(x int) {
	switch {
	case x == 2:
		return
	}
}

func f14(x int) { // want "^empty-lines: extra empty line at the end of a block$"
	switch {
	case x == 2:
		return
	}

}

func f15(x int) {
	switch { // want "^empty-lines: extra empty line at the end of a block$"
	case x == 2:
		return

	}
}

func f16(x int) bool {
	return Query(
		qm("x = ?", x),
	).Execute()
}

func f17(x int) bool { // want "^empty-lines: extra empty line at the end of a block$"
	return Query(
		qm("x = ?", x),
	).Execute()

}

func f18() bool {
	if true {
		if true {
			return true
		}

		// TODO: should we handle the error here?
	}

	return false
}

func w(dur time.Duration) {
	select {
	case <-time.After(dur):
		// TODO: Handle Ctrl-C is pressed in `mysql` client.
		// return 1 when SLEEP() is KILLed
	}
	return
}

func x() {
	if tagArray[2] == "req" {
		bit := len(u.reqFields)
		u.reqFields = append(u.reqFields, name)
		reqMask = uint64(1) << uint(bit)
		// TODO: if we have more than 64 required fields, we end up
		// not verifying that all required fields are present.
		// Fix this, perhaps using a count of required fields?
	}

	if err == nil { // No need to refresh if the stream is over or failed.
		// Consider any buffered body data (read from the conn but not
		// consumed by the client) when computing flow control for this
		// stream.
		v := int(cs.inflow.available()) + cs.bufPipe.Len()
		if v < transportDefaultStreamFlow-transportDefaultStreamMinRefresh {
			streamAdd = int32(transportDefaultStreamFlow - v)
			cs.inflow.add(streamAdd)
		}
	}
}

func ShouldNotWarn() {
	// comment

	println()

	// comment
}

// NR test for issue #739
func NotWarnInSingleLineFunction() { println("foo") }

// Declarations the functions above use.

type query struct{}

func (query) Execute() bool { return true }

func Query(args ...any) query { return query{} }

func qm(s string, args ...any) any { return s }

type flow struct{}

func (flow) available() int32 { return 0 }

func (flow) add(n int32) {}

type pipe struct{}

func (pipe) Len() int { return 0 }

const (
	transportDefaultStreamFlow       = 10
	transportDefaultStreamMinRefresh = 1
)

var (
	tagArray  []string
	u         struct{ reqFields []string }
	name      string
	reqMask   uint64
	err       error
	streamAdd int32
	cs        struct {
		inflow  flow
		bufPipe pipe
	}
)
