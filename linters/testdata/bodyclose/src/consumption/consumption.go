// Adapted from github.com/timakin/bodyclose's tests, MIT License,
// Copyright (c) 2019 Seiji Takahashi.
package consumption

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
)

func consumedWithIOCopy() {
	resp, err := http.Get("http://example.com/") // OK
	if err != nil {
		return
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
}

func consumedWithJSONDecoder() {
	resp, err := http.Get("http://example.com/") // OK
	if err != nil {
		return
	}
	defer resp.Body.Close()

	var data map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&data)
}

func consumedWithBufioScanner() {
	resp, err := http.Get("http://example.com/") // OK
	if err != nil {
		return
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		_ = scanner.Text()
	}
}

func consumedInHelper() {
	resp, err := http.Get("http://example.com/") // OK
	if err != nil {
		return
	}
	defer drainAndClose(resp)
}

func drainAndClose(resp *http.Response) {
	if resp != nil && resp.Body != nil {
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
}

// Reading the body directly consumes it, but is not detected.
func falsePositiveDirectRead() {
	resp, err := http.Get("http://example.com/") // want "response body must be closed and consumed"
	if err != nil {
		return
	}
	defer resp.Body.Close()

	buf := make([]byte, 1024)
	resp.Body.Read(buf)
}

func actuallyNotConsumed() {
	resp, err := http.Get("http://example.com/") // want "response body must be closed and consumed"
	if err != nil {
		return
	}
	defer resp.Body.Close()
}

func neitherClosedNorConsumed() {
	resp, err := http.Get("http://example.com/") // want "response body must be closed and consumed"
	if err != nil {
		return
	}
	_ = resp
}

func requestBodyReadShouldNotInterfere(w http.ResponseWriter, r *http.Request) {
	_, _ = io.ReadAll(r.Body)

	resp, err := http.Get("http://example.com/") // want "response body must be closed and consumed"
	if err != nil {
		return
	}
	defer resp.Body.Close()
}

func properResponseBodyConsumptionWithRequestBody(w http.ResponseWriter, r *http.Request) {
	_, _ = io.ReadAll(r.Body)

	resp, _ := http.Get("http://example.com") // OK
	defer resp.Body.Close()
	io.ReadAll(resp.Body)
}

// bodyclose:handled
func handledResponse() (*http.Response, error) {
	return http.Get("http://example.com")
}

func responseHandledDirectiveSkipsConsumption() {
	_, _ = handledResponse()
}
