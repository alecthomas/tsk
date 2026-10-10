// Adapted from github.com/mgechev/revive's tests, MIT License.

// Test of time suffixes.

// Package foo ...
package foo

import (
	"flag"
	"time"
)

var rpcTimeoutMsec = flag.Duration("rpc_timeout", 100*time.Millisecond, "some flag") // want `^time-naming: var rpcTimeoutMsec is of type \*time\.Duration; don't use unit-specific suffix "Msec"$`

var timeoutSecs = 5 * time.Second // want `^time-naming: var timeoutSecs is of type time\.Duration; don't use unit-specific suffix "Secs"$`
