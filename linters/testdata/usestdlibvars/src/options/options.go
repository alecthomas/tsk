package options

import (
	"net/http"
	"time"
)

var (
	_ = "Monday"                    // want `^"Monday" can be replaced by time.Monday.String\(\)$`
	_ = "March"                     // want `^"March" can be replaced by time.March.String\(\)$`
	_ = "2006-01-02"                // want `^"2006-01-02" can be replaced by time.DateOnly$`
	_ = "SHA-256"                   // want `^"SHA-256" can be replaced by crypto.SHA256.String\(\)$`
	_ = "/_goRPC_"                  // want `^"/_goRPC_" can be replaced by rpc.DefaultRPCPath$`
	_ = "Read Committed"            // want `^"Read Committed" can be replaced by sql.LevelReadCommitted.String\(\)$`
	_ = "Ed25519"                   // want `^"Ed25519" can be replaced by tls.Ed25519.String\(\)$`
	_ = "Complex"                   // want `^"Complex" can be replaced by constant.Complex.String\(\)$`
	_ = time.Date(2023, 3, 2, 3, 4, 5, 0, time.UTC) // want `^"3" can be replaced by time.March$`
	_ = http.StatusText(404)
	_ = http.Request{Method: "GET"}
)
