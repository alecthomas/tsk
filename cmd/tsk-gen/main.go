// Command tsk-gen generates the bindings that expose Go packages to
// linter scripts.
package main

import (
	"github.com/alecthomas/kong"

	"github.com/alecthomas/tsktsk/internal/bindgen"
)

type cli struct {
	bindgen.Config `embed:""`
}

func main() {
	var config cli
	ctx := kong.Parse(&config, kong.Description("Generate script bindings for exposed Go packages."))
	ctx.FatalIfErrorf(bindgen.Generate(config.Config))
}
