package p

import (
	"net/http"
	"net/http/httptest"
	"time"
)

func requests() {
	_, _ = http.NewRequest("GET", "localhost", nil) // want `^"GET" can be replaced by http.MethodGet$`
	_, _ = http.NewRequest("get", "localhost", nil) // want `^"get" can be replaced by http.MethodGet$`
	_ = httptest.NewRequest("POST", "localhost", nil) // want `^"POST" can be replaced by http.MethodPost$`
	_ = http.Request{Method: "PUT"} // want `^"PUT" can be replaced by http.MethodPut$`
	_ = http.StatusText(404) // want `^"404" can be replaced by http.StatusNotFound$`
	_ = http.Response{StatusCode: 418} // want `^"418" can be replaced by http.StatusTeapot$`
	_ = httptest.ResponseRecorder{Code: 200} // want `^"200" can be replaced by http.StatusOK$`
	_ = http.StatusText(999)
	_ = time.Date(2023, 1, 2, 3, 4, 5, 0, time.UTC)
	_ = "Monday"
}

func handler(w http.ResponseWriter, r *http.Request, resp *http.Response) {
	w.WriteHeader(500) // want `^"500" can be replaced by http.StatusInternalServerError$`
	http.Error(w, "", 400) // want `^"400" can be replaced by http.StatusBadRequest$`
	http.Redirect(w, r, "/", 301) // want `^"301" can be replaced by http.StatusMovedPermanently$`
	if r.Method == "DELETE" { // want `^"DELETE" can be replaced by http.MethodDelete$`
		return
	}
	if resp.StatusCode >= 400 {
		return
	}
	switch resp.StatusCode {
	case 201: // want `^"201" can be replaced by http.StatusCreated$`
	case 299:
	}
}
