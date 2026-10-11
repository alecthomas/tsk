// The "// want" checking here is adapted from
// golang.org/x/tools/go/analysis/analysistest, Copyright 2018 The Go Authors,
// under a BSD-style license.

package scripttest

import (
	"fmt"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"text/scanner"

	"github.com/alecthomas/errors"
	"golang.org/x/tools/go/analysis"
	"golang.org/x/tools/go/analysis/checker"
	"golang.org/x/tools/go/packages"

	"github.com/alecthomas/tsk/internal/lint"
)

// Testing receives a case's failures.
type Testing interface {
	Errorf(format string, args ...any)
}

// analyze runs analyzer over packages matching patterns in dir, the root of a
// GOPATH-style tree or a module, and checks its findings against the "// want"
// comments in their files, as analysistest.Run does.
func analyze(t Testing, store *Store, dir string, analyzer *analysis.Analyzer, patterns ...string) {
	pkgs, err := store.Load(dir, patterns, lint.NeedFacts([]*analysis.Analyzer{analyzer}))
	if err != nil {
		t.Errorf("loading %s: %v", patterns, err)
		return
	}
	graph, err := checker.Analyze([]*analysis.Analyzer{analyzer}, pkgs, &checker.Options{SanityCheck: true})
	if err != nil {
		t.Errorf("Analyze: %v", err)
		return
	}
	for _, act := range graph.Roots {
		if act.Err != nil {
			t.Errorf("error analyzing %s: %v", act, act.Err)
			continue
		}
		check(t, dir, act)
	}
}

// expectationKey is a line that "// want" comments expect findings on.
type expectationKey struct {
	file string
	line int
}

// check reports to t each of act's diagnostics and facts that no "// want"
// comment expects, and each expectation that none matched.
func check(t Testing, gopath string, act *checker.Action) {
	e := newExpectations(t, gopath)
	e.readSyntax(act.Package)
	files := act.Package.OtherFiles
	// These analyzers check every build configuration, so their
	// expectations include files the build ignores.
	switch act.Analyzer.Name {
	case "buildtag", "directive", "plusbuild":
		files = slices.Concat(files, act.Package.IgnoredFiles)
	}
	e.readFiles(files)

	for _, d := range act.Diagnostics {
		e.match(act.Package.Fset.Position(d.Pos), "diagnostic", "", d.Message)
	}
	// Only facts about this package are checked. Package facts belong to the
	// start of its first file, and object facts to the object's declaration.
	for _, fact := range act.AllPackageFacts() {
		if fact.Package == act.Package.Types {
			posn := act.Package.Fset.Position(act.Package.Syntax[0].Pos())
			posn.Line, posn.Column = 1, 1
			e.match(posn, "fact", "package", fmt.Sprint(fact))
		}
	}
	// Facts are checked in position order so failures are deterministic.
	objFacts := act.AllObjectFacts()
	sort.Slice(objFacts, func(i, j int) bool { return objFacts[i].Object.Pos() < objFacts[j].Object.Pos() })
	for _, fact := range objFacts {
		if obj := fact.Object; obj.Pkg() == act.Package.Types {
			e.match(act.Package.Fset.Position(obj.Pos()), "fact", obj.Name(), fmt.Sprint(fact.Fact))
		}
	}
	e.reportUnmatched()
}

// expectations holds a package's unmatched "// want" expectations, reporting
// problems with them to t.
type expectations struct {
	t      Testing
	gopath string
	want   map[expectationKey][]expectation
}

// newExpectations returns no expectations for files under gopath.
func newExpectations(t Testing, gopath string) *expectations {
	return &expectations{t: t, gopath: gopath, want: map[expectationKey][]expectation{}}
}

// add records the expectations in a comment's text, if it has any.
func (e *expectations) add(filename string, line int, text string) {
	// Any comment starting with "want" is an expectation, even without
	// whitespace following it.
	rest, ok := strings.CutPrefix(strings.TrimSpace(text), "want")
	if !ok {
		return
	}
	lineDelta, expects, err := parseExpectations(rest)
	if err != nil {
		e.t.Errorf("%s:%d: in 'want' comment: %s", filename, line, err)
		return
	}
	if len(expects) > 0 {
		e.want[expectationKey{filename, line + lineDelta}] = expects
	}
}

// readSyntax records the expectations in the comments of pkg's Go files.
func (e *expectations) readSyntax(pkg *packages.Package) {
	for _, f := range pkg.Syntax {
		for _, group := range f.Comments {
			for _, c := range group.List {
				text := strings.TrimPrefix(c.Text, "//")
				if text == c.Text {
					text = strings.TrimSuffix(strings.TrimPrefix(text, "/*"), "*/")
				}
				// "//...// want" starts at "want", so comments on comments,
				// such as build tags, can have expectations.
				if i := strings.Index(text, "// want"); i >= 0 {
					text = text[i+len("// "):]
				}
				// Each comment is resolved separately because //line
				// directives can change its file.
				posn := pkg.Fset.Position(c.Pos())
				e.add(sanitize(e.gopath, posn.Filename), posn.Line, text)
			}
		}
	}
}

// readFiles records the expectations in the line comments of non-Go files.
func (e *expectations) readFiles(files []string) {
	for _, filename := range files {
		data, err := os.ReadFile(filename)
		if err != nil {
			e.t.Errorf("can't read '// want' comments from %s: %v", filename, err)
			continue
		}
		filename := sanitize(e.gopath, filename)
		for i, line := range strings.Split(string(data), "\n") {
			if j := strings.Index(line, "// want"); j >= 0 {
				line = line[j:]
			}
			if j := strings.Index(line, "//"); j >= 0 {
				e.add(filename, i+1, line[j+len("//"):])
			}
		}
	}
}

// match removes the expectation a reported message matches, or reports the
// message as unexpected.
func (e *expectations) match(posn token.Position, kind, name, message string) {
	posn.Filename = sanitize(e.gopath, posn.Filename)
	k := expectationKey{posn.Filename, posn.Line}
	expects := e.want[k]
	var unmatched []string
	for i, exp := range expects {
		if exp.kind != kind || exp.name != name {
			continue
		}
		if exp.rx.MatchString(message) {
			expects[i] = expects[len(expects)-1]
			e.want[k] = expects[:len(expects)-1]
			return
		}
		unmatched = append(unmatched, fmt.Sprintf("%#q", exp.rx))
	}
	if len(unmatched) == 0 {
		e.t.Errorf("%v: unexpected %s: %v", posn, kind, message)
	} else {
		e.t.Errorf("%v: %s %q does not match pattern %s", posn, kind, message, strings.Join(unmatched, " or "))
	}
}

// reportUnmatched reports each expectation that no message matched, in order.
func (e *expectations) reportUnmatched() {
	var surplus []string
	for k, expects := range e.want {
		for _, exp := range expects {
			surplus = append(surplus, fmt.Sprintf("%s:%d: no %s was reported matching %#q", k.file, k.line, exp.kind, exp.rx))
		}
	}
	slices.Sort(surplus)
	for _, err := range surplus {
		e.t.Errorf("%s", err)
	}
}

// expectation is a diagnostic or fact a "// want" comment expects.
type expectation struct {
	// kind is "diagnostic" or "fact".
	kind string
	// name is the object a fact is about, or "package" for package facts.
	name string
	rx   *regexp.Regexp
}

// parseExpectations parses what follows "want" in a comment: an optional +N
// line offset, then "rx" diagnostics and name:"rx" facts.
func parseExpectations(text string) (lineDelta int, expects []expectation, err error) {
	var scanErr string
	sc := new(scanner.Scanner).Init(strings.NewReader(text))
	sc.Error = func(_ *scanner.Scanner, msg string) { scanErr = msg }
	sc.Mode = scanner.ScanIdents | scanner.ScanStrings | scanner.ScanRawStrings | scanner.ScanInts
	scanRegexp := func(tok rune) (*regexp.Regexp, error) {
		if tok != scanner.String && tok != scanner.RawString {
			return nil, errors.Errorf("got %s, want regular expression", scanner.TokenString(tok))
		}
		pattern, _ := strconv.Unquote(sc.TokenText()) //nolint:errcheck // The scanner only yields valid literals.
		rx, err := regexp.Compile(pattern)
		return rx, errors.WithStack(err)
	}
	for {
		switch tok := sc.Scan(); tok {
		case '+':
			if tok = sc.Scan(); tok != scanner.Int {
				return 0, nil, errors.Errorf("got +%s, want +Int", scanner.TokenString(tok))
			}
			lineDelta, _ = strconv.Atoi(sc.TokenText()) //nolint:errcheck // The scanner only yields valid integers.
		case scanner.String, scanner.RawString:
			rx, err := scanRegexp(tok)
			if err != nil {
				return 0, nil, err
			}
			expects = append(expects, expectation{kind: "diagnostic", rx: rx})
		case scanner.Ident:
			name := sc.TokenText()
			if tok = sc.Scan(); tok != ':' {
				return 0, nil, errors.Errorf("got %s after %s, want ':'", scanner.TokenString(tok), name)
			}
			rx, err := scanRegexp(sc.Scan())
			if err != nil {
				return 0, nil, err
			}
			expects = append(expects, expectation{kind: "fact", name: name, rx: rx})
		case scanner.EOF:
			if scanErr != "" {
				return 0, nil, errors.New(scanErr)
			}
			return lineDelta, expects, nil
		default:
			return 0, nil, errors.Errorf("unexpected %s", scanner.TokenString(tok))
		}
	}
}

// sanitize strips the GOPATH's src directory from filename.
func sanitize(gopath, filename string) string {
	prefix := gopath + string(os.PathSeparator) + "src" + string(os.PathSeparator)
	return filepath.ToSlash(strings.TrimPrefix(filename, prefix))
}
