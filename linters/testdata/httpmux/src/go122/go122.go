package go122

import "net/http"

func _() {
	http.HandleFunc("GET /x", nil) // not reported: the module uses Go 1.22
}
