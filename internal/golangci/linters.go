package golangci

// golangciLinters returns golangci-lint v2.14.0's linters. An analyzer not
// among them, such as a project's own script, is left enabled: the config
// cannot name it.
func golangciLinters() []string {
	return []string{
		"arangolint", "asasalint", "asciicheck", "bidichk", "bodyclose", "canonicalheader", "clickhouselint",
		"containedctx", "contextcheck", "copyloopvar", "cyclop", "decorder", "depguard", "dogsled", "dupl",
		"dupword", "durationcheck", "embeddedstructfieldcheck", "err113", "errcheck", "errchkjson", "errname",
		"errorlint", "exhaustive", "exhaustruct", "exhaustruct_v5", "exptostd", "fatcontext", "forbidigo",
		"forcetypeassert", "funcorder", "funlen", "ginkgolinter", "gocheckcompilerdirectives", "gochecknoglobals",
		"gochecknoinits", "gochecksumtype", "gocognit", "goconst", "gocritic", "gocyclo", "godoclint", "godot",
		"godox", "goheader", "gomoddirectives", "gomodguard", "gomodguard_v2", "goprintffuncname", "gosec",
		"gosmopolitan", "govet", "grouper", "iface", "importas", "inamedparam", "ineffassign", "interfacebloat",
		"intrange", "iotamixing", "ireturn", "lll", "loggercheck", "maintidx", "makezero", "mirror", "misspell",
		"mnd", "modernize", "musttag", "nakedret", "nestif", "nilerr", "nilnesserr", "nilnil", "nlreturn", "noctx",
		"noinlineerr", "nolintlint", "nonamedreturns", "nosprintfhostport", "paralleltest", "perfsprint",
		"prealloc", "predeclared", "promlinter", "protogetter", "reassign", "recvcheck", "revive", "rowserrcheck",
		"sloglint", "spancheck", "sqlclosecheck", "staticcheck", "tagalign", "tagliatelle", "testableexamples",
		"testifylint", "testpackage", "thelper", "tparallel", "unconvert", "unparam", "unqueryvet", "unused",
		"usestdlibvars", "usetesting", "varnamelen", "wastedassign", "whitespace", "wrapcheck", "wsl", "wsl_v5",
		"zerologlint",
	}
}

// standardLinters returns the set golangci-lint enables with linters.default:
// standard, its default.
func standardLinters() []string {
	return []string{"errcheck", "govet", "ineffassign", "staticcheck", "unused"}
}

// govet is golangci-lint's linter running go vet's analyzers, which tsk has
// as separate analyzers.
const govet = "govet"

// vetAnalyzers returns the analyzers golangci-lint v2.14.0's govet can run.
func vetAnalyzers() []string {
	return []string{
		"appends", "asmdecl", "assign", "atomic", "atomicalign", "bools", "buildtag", "cgocall", "composites",
		"copylocks", "deepequalerrors", "defers", "directive", "errorsas", "fieldalignment", "findcall",
		"framepointer", "hostport", "httpmux", "httpresponse", "ifaceassert", "inline", "loopclosure", "lostcancel",
		"nilfunc", "nilness", "printf", "reflectvaluecompare", "shadow", "shift", "sigchanyzer", "slog", "sortslice",
		"stdmethods", "stdversion", "stringintconv", "structtag", "testinggoroutine", "tests", "timeformat",
		"unmarshal", "unreachable", "unsafeptr", "unusedresult", "unusedwrite", "waitgroup",
	}
}

// offVetAnalyzers returns the analyzers govet does not run unless settings
// choose them. It runs the rest: go vet's, and inline.
func offVetAnalyzers() []string {
	return []string{
		"atomicalign", "deepequalerrors", "fieldalignment", "findcall", "httpmux", "nilness", "reflectvaluecompare",
		"shadow", "sortslice", "unusedwrite",
	}
}

// exhaustruct is the name of tsk's exhaustruct analyzer and of golangci-lint's
// exhaustruct version 4.
const exhaustruct = "exhaustruct"

// analyzerName returns the tsk analyzer for a golangci-lint linter. tsk's
// exhaustruct ports version 5, which golangci-lint calls exhaustruct_v5.
func analyzerName(linter string) string {
	if linter == "exhaustruct_v5" {
		return exhaustruct
	}
	return linter
}

func analyzerNames(linters []string) []string {
	names := make([]string, 0, len(linters))
	for _, linter := range linters {
		names = append(names, analyzerName(linter))
	}
	return names
}

// exhaustructV4Options maps the options of golangci-lint's exhaustruct,
// version 4, that version 5 lacks to what version 5 has instead.
func exhaustructV4Options() map[string]string {
	return map[string]string{
		"include":        "enforce-patterns with explicit-mode",
		"exclude":        "ignore-patterns",
		"allow-empty-rx": "allow-empty-patterns",
	}
}

// configNames returns the config files golangci-lint looks for, in its order.
func configNames() []string {
	return []string{".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"}
}
