// Adapted from github.com/curioswitch/go-reassign's tests, MIT License.
package patterns

import "net/http"

func _() {
	http.DefaultClient = nil      // want "^reassigning variable DefaultClient in other package http$"
	http.DefaultTransport = nil   // want "reassigning variable DefaultTransport"
	http.ErrServerClosed = nil
}
