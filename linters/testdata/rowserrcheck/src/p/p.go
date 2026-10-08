// Adapted from github.com/jingyugao/rowserrcheck's tests, MIT License.
package p

import (
	"database/sql"

	"db"
)

func _(conn *sql.DB) {
	rows, _ := conn.Query("SELECT 1") // want "^rows.Err must be checked$"
	defer rows.Close()
	for rows.Next() {
	}
}

func _(conn *sql.DB) error {
	rows, err := conn.Query("SELECT 1")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
	}
	return rows.Err()
}

func _(conn *sql.DB) {
	rows, _ := conn.Query("SELECT 1")
	defer func() {
		_ = rows.Err()
	}()
}

// Functions returning rows leave the check to their callers.
func query(conn *sql.DB) (*sql.Rows, error) {
	return conn.Query("SELECT 1")
}

func _(c *db.Conn) {
	rows := c.Query() // want "rows.Err must be checked"
	for rows.Next() {
	}
}

func _(c *db.Conn) error {
	rows := c.Query()
	return rows.Err()
}
