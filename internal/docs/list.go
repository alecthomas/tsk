package docs

import (
	"io"
	"strings"
	"text/tabwriter"

	"github.com/alecthomas/errors"
)

// List writes one line per analyzer: its name, whether it is enabled, where
// it is defined, and the first line of its documentation.
func List(w io.Writer, analyzers []Analyzer) error {
	table := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	for _, analyzer := range analyzers {
		status := "disabled"
		if analyzer.Enabled {
			status = "enabled"
		}
		summary, _, _ := strings.Cut(analyzer.Doc, "\n")
		if _, err := io.WriteString(table, strings.Join([]string{analyzer.Name, status, analyzer.Source, summary}, "\t")+"\n"); err != nil {
			return errors.WithStack(err)
		}
	}
	return errors.WithStack(table.Flush())
}
