package strict

var a = 1 /* want "^directive `//nolint` should mention specific linter such as `//nolint:my-linter`$" "^directive `//nolint` should provide explanation such as `//nolint // this is why`$" */ //nolint

var b = 1 /* want "^directive `//nolint:all // why` should mention specific linter such as `//nolint:my-linter`$" */ //nolint:all // why

var c = 1 /* want "^directive `//nolint:errcheck //` should provide explanation such as `//nolint:errcheck // this is why`$" */ //nolint:errcheck //

var d = 1 /* want "^directive `//nolint:funlen,errcheck` should provide explanation such as `//nolint:funlen,errcheck // this is why`$" */ //nolint:funlen,errcheck

// Every linter named is allowed no explanation.
var e = 1 //nolint:funlen,lll

var f = 1 //nolint:errcheck // because
