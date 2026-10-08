// Adapted from github.com/timakin/bodyclose's tests, MIT License,
// Copyright (c) 2019 Seiji Takahashi.
package a

import (
	"fmt"
	"io"
	"io/ioutil"
	"net/http"
	"net/http/httptest"
	"time"
)

func get() *http.Response {
	resp, _ := http.Get("https://example.com")
	return resp
}

func issue1() {
	resp := get()
	resp.Body.Close()
}

func closeBody(c io.Closer) {
	_ = c.Close()
}

func issue3_1() {
	resp, _ := http.Get("https://example.com")
	defer closeBody(resp.Body)
}

func issue3_2() {
	resp, _ := http.Get("https://example.com")
	defer func() {
		_ = resp.Body.Close()
	}()
}

func issue3_3() {
	resp, err := http.DefaultClient.Do(nil)
	if err != nil {
		// handle err
	}
	defer func() { fmt.Println(resp.Body.Close()) }()
}

func funcReceiver(msg string, er error) {
	fmt.Println(msg)
	if er != nil {
		fmt.Println(er)
	}
}

func issue3_4() {
	resp, _ := http.Get("https://example.com")
	defer func() { funcReceiver("test", resp.Body.Close()) }()
}

func issue4_1() {
	resp, _ := http.Get("https://example.com") // want "response body must be closed"

	foo(resp.Body)
}

func foo(r io.ReadCloser) {}

func issue4_2() {
	resp, _ := http.Get("https://example.com") // want "response body must be closed"

	_ = http.MaxBytesReader(nil, resp.Body, 1024)
}

func f12() {
	res, _ := http.Get("http://example.com/") // OK
	defer func() {
		io.Copy(ioutil.Discard, res.Body)
		res.Body.Close()
	}()
}

func issue27_1(url string) (io.ReadCloser, error) { // body should be closed by User
	r, err := http.DefaultClient.Get(url)
	if err != nil {
		return nil, err
	}
	return r.Body, nil
}

func issue27_2(url string) (io.Closer, error) { // body should be closed by User
	r, err := http.DefaultClient.Get(url)
	if err != nil {
		return nil, err
	}
	return r.Body, nil
}

var resp *http.Response

func issue36_1() {
	resp, _ = http.Get("https://example.com") // OK
	resp.Body.Close()
}

func issue36_2() {
	// Also OK. Responses stored in global variables are not checked.
	resp, _ = http.Get("https://example.com")
}

type MyResponse struct {
	Original *http.Response
}

func (r *MyResponse) Response() *http.Response {
	return r.Original
}

// issue42_1 is case when http.Response from struct field
func issue42_1() {
	r := &MyResponse{}
	r.Original, _ = http.Get("http://example.com/") // OK
	_ = r.Original.Body.Close()
}

// issue42_2 is case when http.Response from a function
func issue42_2() {
	r := &MyResponse{}
	r.Original, _ = http.Get("http://example.com/") // OK
	_ = r.Response().Body.Close()
}

func issue47() {
	w := httptest.NewRecorder()
	resp := w.Result()
	defer func() {
		_ = resp.Body.Close()
	}()
	_, _ = io.ReadAll(resp.Body)
}

func RequestHandler(w http.ResponseWriter, r *http.Request) {
	rc := http.NewResponseController(w) // OK
	_ = rc.SetWriteDeadline(time.Time{})
	_, _ = io.Copy(w, r.Body)
}

func issue59() {
	w := httptest.NewRecorder()
	resp := w.Result() // OK
	_, _ = io.ReadAll(resp.Body)
}

func issue61() {
	var resp *http.Response
	if true {
		resp, _ = http.Get("http://example.com") // OK
	}
	defer resp.Body.Close()
}
