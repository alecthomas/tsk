// Adapted from github.com/ryanrolds/sqlclosecheck's tests, MIT License.
package p

import (
	"context"
	"database/sql"
)

func _(ctx context.Context, db *sql.DB) {
	rows, _ := db.QueryContext(ctx, "SELECT 1") // want "^Rows/Stmt/NamedStmt was not closed$"
	_ = rows.Err()
}

func _(ctx context.Context, db *sql.DB) {
	rows, _ := db.QueryContext(ctx, "SELECT 1")
	defer rows.Close()
}

func _(ctx context.Context, db *sql.DB) {
	rows, _ := db.QueryContext(ctx, "SELECT 1")
	rows.Close() // want "^Close should use defer$"
}

func _(ctx context.Context, db *sql.DB) {
	stmt, _ := db.PrepareContext(ctx, "SELECT 1") // want "Rows/Stmt/NamedStmt was not closed"
	_ = stmt
}

func _(ctx context.Context, db *sql.DB) {
	stmt, _ := db.PrepareContext(ctx, "SELECT 1")
	defer func() {
		_ = stmt.Close()
	}()
}

func query(ctx context.Context, db *sql.DB) (*sql.Rows, error) {
	return db.QueryContext(ctx, "SELECT 1")
}

func _(ctx context.Context, db *sql.DB) {
	rows, _ := query(ctx, db)
	consume(rows)
}

func consume(rows *sql.Rows) { defer rows.Close() }
