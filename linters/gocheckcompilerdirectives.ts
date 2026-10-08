import { defineAnalyzer } from "tsk";

// known lists the directives the Go toolchain recognises.
const known = new Set([
  "build",
  "cgo_dynamic_linker",
  "cgo_export_dynamic",
  "cgo_export_static",
  "cgo_import_dynamic",
  "cgo_import_static",
  "cgo_ldflag",
  "cgo_unsafe_args",
  "debug",
  "embed",
  "fix",
  "generate",
  "linkname",
  "nocheckptr",
  "noescape",
  "noinline",
  "nointerface",
  "norace",
  "nosplit",
  "notinheap",
  "nowritebarrier",
  "nowritebarrierrec",
  "systemstack",
  "uintptrescapes",
  "uintptrkeepalive",
  "wasmimport",
  "wasmexport",
  "yeswritebarrierrec",
]);

export default defineAnalyzer({
  name: "gocheckcompilerdirectives",
  doc: `check that go compiler directive comments (//go:) are valid

The compiler silently ignores directives with a space after // and ones it
does not know, such as a misspelt //go:noinlne. As upstream, a directive is
only checked when followed by a space.`,
  url: "https://github.com/leighmcculloch/gocheckcompilerdirectives",
  run(pass) {
    for (const file of pass.files) {
      for (const group of file.comments) {
        for (const comment of group!.list) {
          const match = /^\/\/( *)go:([^ ]*) /.exec(comment!.text);
          if (match === null || match[2] === "") {
            continue;
          }
          const [prefix, spaces, directive] = [match[0].slice(0, -1), match[1], match[2]];
          if (spaces !== "") {
            pass.report({ pos: comment!.pos(), end: comment!.end(), message: `compiler directive contains space: ${prefix}` });
          }
          if (!known.has(directive)) {
            pass.report({ pos: comment!.pos(), end: comment!.end(), message: `compiler directive unrecognized: ${prefix}` });
          }
        }
      }
    }
  },
});
