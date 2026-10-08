// Adapted from github.com/stbenjam/no-sprintf-host-port's tests, MIT License.
package p

import (
	"fmt"
	"net"
)

func _(host, port, user string) {
	_ = fmt.Sprintf("http://%s:%s/path", host, port)           // want "^host:port in url should be constructed with net.JoinHostPort and not directly with fmt.Sprintf$"
	_ = fmt.Sprintf("postgres://%s:%d", host, 5432)            // want "net.JoinHostPort"
	_ = fmt.Sprintf("https://%s@%s:%s", user, host, port)      // want "net.JoinHostPort"
	_ = fmt.Sprintf(`grpc+tls://%s:443`, host)                 // want "net.JoinHostPort"
	_ = fmt.Sprintf("http://%s:%s", "[::1]", port)             // want "net.JoinHostPort"
	_ = fmt.Sprintf("http://%s:%s", "localhost", port)
	_ = fmt.Sprintf("http://%s/%s", host, port)
	_ = fmt.Sprintf("http://%s:%s@%s/", user, port, host)
	_ = fmt.Sprintf("%s:%s", host, port)
	_ = fmt.Sprintf("http://%s", net.JoinHostPort(host, port))
}
