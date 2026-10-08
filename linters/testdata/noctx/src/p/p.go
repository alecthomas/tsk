// Adapted from github.com/sonatard/noctx's tests, MIT License.
package p

import (
	"context"
	"database/sql"
	"net/http"
	"os/exec"
)

func _(ctx context.Context, db *sql.DB) {
	_, _ = http.Get("https://example.com") // want `^net/http\.Get must not be called\. use net/http\.NewRequestWithContext and \(\*net/http\.Client\)\.Do\(\*http\.Request\)$`
	_, _ = http.NewRequest("GET", "/", nil) // want `net/http\.NewRequest must not be called`
	_, _ = http.NewRequestWithContext(ctx, "GET", "/", nil)
	_, _ = db.Query("SELECT 1")             // want `^\(\*database/sql\.DB\)\.Query must not be called\. use \(\*database/sql\.DB\)\.QueryContext$`
	_, _ = db.QueryContext(ctx, "SELECT 1")
	_ = exec.Command("true")                // want `os/exec\.Command must not be called`
	defer db.Ping()                         // want `\(\*database/sql\.DB\)\.Ping must not be called`
}
