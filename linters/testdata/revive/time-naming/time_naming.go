// Adapted from github.com/mgechev/revive's tests, MIT License.

package foo

import "time"

var (
	Hour     = time.Hour // want `^time-naming: var Hour is of type time\.Duration; don't use unit-specific suffix "Hour"$`
	oneHour  = time.Hour // want `^time-naming: var oneHour is of type time\.Duration; don't use unit-specific suffix "Hour"$`
	twoHours = 2 * time.Hour // want `^time-naming: var twoHours is of type time\.Duration; don't use unit-specific suffix "Hours"$`
	TenHours = 10 * time.Hour // want `^time-naming: var TenHours is of type time\.Duration; don't use unit-specific suffix "Hours"$`
	SixHours = 6 * time.Hour // want `^time-naming: var SixHours is of type time\.Duration; don't use unit-specific suffix "Hours"$`

	oneMin     = time.Minute // want `^time-naming: var oneMin is of type time\.Duration; don't use unit-specific suffix "Min"$`
	Min        = time.Minute // want `^time-naming: var Min is of type time\.Duration; don't use unit-specific suffix "Min"$`
	twoMin     = 2 * time.Minute // want `^time-naming: var twoMin is of type time\.Duration; don't use unit-specific suffix "Min"$`
	SixMin     = 6 * time.Minute // want `^time-naming: var SixMin is of type time\.Duration; don't use unit-specific suffix "Min"$`
	SixMins    = 6 * time.Minute // want `^time-naming: var SixMins is of type time\.Duration; don't use unit-specific suffix "Mins"$`
	SixMinutes = 6 * time.Minute // want `^time-naming: var SixMinutes is of type time\.Duration; don't use unit-specific suffix "Minutes"$`

	oneSec     = time.Second // want `^time-naming: var oneSec is of type time\.Duration; don't use unit-specific suffix "Sec"$`
	Sec        = time.Second // want `^time-naming: var Sec is of type time\.Duration; don't use unit-specific suffix "Sec"$`
	SixSec     = 6 * time.Second // want `^time-naming: var SixSec is of type time\.Duration; don't use unit-specific suffix "Sec"$`
	twoSecs    = 2 * time.Second // want `^time-naming: var twoSecs is of type time\.Duration; don't use unit-specific suffix "Secs"$`
	SixSeconds = 6 * time.Second // want `^time-naming: var SixSeconds is of type time\.Duration; don't use unit-specific suffix "Seconds"$`
	oneSecond  = time.Second // want `^time-naming: var oneSecond is of type time\.Duration; don't use unit-specific suffix "Second"$`
	Second     = time.Second // want `^time-naming: var Second is of type time\.Duration; don't use unit-specific suffix "Second"$`

	SixMsec         = 6 * time.Millisecond // want `^time-naming: var SixMsec is of type time\.Duration; don't use unit-specific suffix "Msec"$`
	oneMsec         = time.Millisecond // want `^time-naming: var oneMsec is of type time\.Duration; don't use unit-specific suffix "Msec"$`
	SixMsecs        = 6 * time.Millisecond // want `^time-naming: var SixMsecs is of type time\.Duration; don't use unit-specific suffix "Msecs"$`
	oneMilli        = time.Millisecond // want `^time-naming: var oneMilli is of type time\.Duration; don't use unit-specific suffix "Milli"$`
	SixMillis       = 6 * time.Millisecond // want `^time-naming: var SixMillis is of type time\.Duration; don't use unit-specific suffix "Millis"$`
	SixMilliseconds = 6 * time.Millisecond // want `^time-naming: var SixMilliseconds is of type time\.Duration; don't use unit-specific suffix "Milliseconds"$`
	oneMillisecond  = time.Millisecond // want `^time-naming: var oneMillisecond is of type time\.Duration; don't use unit-specific suffix "Millisecond"$`
	Millisecond     = time.Millisecond // want `^time-naming: var Millisecond is of type time\.Duration; don't use unit-specific suffix "Millisecond"$`

	oneUsec         = 1 * time.Microsecond // want `^time-naming: var oneUsec is of type time\.Duration; don't use unit-specific suffix "Usec"$`
	twoUsec         = 2 * time.Microsecond // want `^time-naming: var twoUsec is of type time\.Duration; don't use unit-specific suffix "Usec"$`
	SixUsec         = 6 * time.Microsecond // want `^time-naming: var SixUsec is of type time\.Duration; don't use unit-specific suffix "Usec"$`
	SixUsecs        = 6 * time.Microsecond // want `^time-naming: var SixUsecs is of type time\.Duration; don't use unit-specific suffix "Usecs"$`
	twoMicroseconds = 2 * time.Microsecond // want `^time-naming: var twoMicroseconds is of type time\.Duration; don't use unit-specific suffix "Microseconds"$`
	SixMicroseconds = 6 * time.Microsecond // want `^time-naming: var SixMicroseconds is of type time\.Duration; don't use unit-specific suffix "Microseconds"$`
	oneMicrosecond  = 1 * time.Microsecond // want `^time-naming: var oneMicrosecond is of type time\.Duration; don't use unit-specific suffix "Microsecond"$`
	SixMS           = 6 * time.Microsecond // want `^time-naming: var SixMS is of type time\.Duration; don't use unit-specific suffix "MS"$`
	oneMS           = 1 * time.Microsecond // want `^time-naming: var oneMS is of type time\.Duration; don't use unit-specific suffix "MS"$`

)
