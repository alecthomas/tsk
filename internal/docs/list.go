package docs

import (
	"encoding/json"
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

// listed is one analyzer as ListJSON writes it.
type listed struct {
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
	Source  string `json:"source"`
	Doc     string `json:"doc"`
	URL     string `json:"url,omitzero"`
}

// ListJSON writes the analyzers as a JSON array, with each one's full
// documentation rather than only its first line.
func ListJSON(w io.Writer, analyzers []Analyzer) error {
	entries := make([]listed, 0, len(analyzers))
	for _, analyzer := range analyzers {
		entries = append(entries, listed{Name: analyzer.Name, Enabled: analyzer.Enabled, Source: analyzer.Source, Doc: analyzer.Doc, URL: analyzer.URL})
	}
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return errors.Wrap(encoder.Encode(entries), "encode analyzers")
}
