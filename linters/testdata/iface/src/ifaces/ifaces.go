// Adapted from github.com/uudashr/iface's tests, MIT License.
package ifaces

type Pinger interface { // want "^identical: interface 'Pinger' contains identical methods or type constraints with another interface, causing redundancy \\(see: Healthcheck\\)$"
	Ping() error
}

type Healthcheck interface { // want "^identical: interface 'Healthcheck' .* \\(see: Pinger\\)$"
	Ping() error
}

//iface:ignore=identical
type Probe interface {
	Ping() error
}

type Logger interface { // want "^unused: interface 'Logger' is declared but not used within the package$"
	Log(msg string) // want "^unusedmethod: method 'Log\\(\\)' is declared on interface 'Logger'"
}

type matcher interface {
	Match() bool
	Unused() // want "^unusedmethod: method 'Unused\\(\\)' is declared on interface 'matcher' but not used within the package$"
}

func Find(m matcher) bool { // want "^unexported: unexported interface 'matcher' used as parameter in exported function 'Find'$"
	return m.Match()
}

func check(p Pinger, h Healthcheck, pr Probe) error {
	_ = h.Ping()
	_ = pr.Ping()
	return p.Ping()
}
