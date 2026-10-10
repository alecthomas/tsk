package directives

var a = 1 /* want "^directive `// nolint:errcheck` should be written without leading space as `//nolint:errcheck`$" */ // nolint:errcheck

var b = 1 /* want "^directive `//nolint because` should match `//nolint because\\[:<comma-separated-linters>\\] \\[// <explanation>\\]`$" */ //nolint because

var c = 1 /* want "^directive `//nolint:errcheck,` should match `//nolint\\[:<comma-separated-linters>\\] \\[// <explanation>\\]`$" */ //nolint:errcheck,

var d = 1 /* want "^directive `//  nolint because` should be written without leading space as `//nolint because`$" "^directive `//  nolint because` should match `// nolint because\\[:<comma-separated-linters>\\] \\[// <explanation>\\]`$" */ //  nolint because

// Well-formed directives.
var e = 1 //nolint
var f = 1 //nolint:errcheck, unused // because
var g = 1 //nolint:errcheck//because

// Not directives.
var h = 1 //NOLINT:errcheck
var i = 1 //nolintx
var j = 1 /* nolint:errcheck */
var k = 1 // some text //nolint:errcheck
