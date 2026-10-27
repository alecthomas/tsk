// Port of golang.org/x/tools/go/analysis/passes/directive at v0.50.0.
import type * as ast from "go/ast";
import * as parser from "go/parser";
import type * as token from "go/token";
import { defineAnalyzer, type Pass } from "tsk";
import { byteLength } from "./internal/utf8";

export default defineAnalyzer({
  name: "directive",
  doc: `check Go toolchain directives such as //go:debug

This analyzer checks for problems with known Go toolchain directives
in all Go source files in a package directory, even those excluded by
//go:build constraints, and all non-Go source files too.

For //go:debug (see https://go.dev/doc/godebug), the analyzer checks
that the directives are placed only in Go source files, only above the
package comment, and only in package main or *_test.go files.

This analyzer does not check //go:build, which is handled by the
buildtag analyzer.`,
  group: "govet",
  run(pass) {
    for (const f of pass.files) {
      checkGoFile(pass, f!);
    }
    for (const name of pass.otherFiles) {
      checkOtherFile(pass, name);
    }
    for (const name of pass.ignoredFiles) {
      if (name.endsWith(".go")) {
        let f: ast.File;
        try {
          f = parser.parseFile(pass.fset, name, pass.readFile(name), parser.ParseComments)!;
        } catch {
          // Not valid Go source code: not ours to diagnose.
          continue;
        }
        checkGoFile(pass, f);
      } else {
        checkOtherFile(pass, name);
      }
    }
  },
});

function checkGoFile(pass: Pass<unknown>, f: ast.File): void {
  const check = new Checker(pass, pass.fset.file(f.package)!.name(), f);
  for (const group of f.comments) {
    // A //go:debug comment is ignored after the package declaration.
    if (group!.pos() >= f.package) {
      check.inHeader = false;
    }
    for (const c of group!.list) {
      check.comment(c!.slash, c!.text);
    }
  }
}

function checkOtherFile(pass: Pass<unknown>, filename: string): void {
  const content = pass.readFile(filename);
  const tf = pass.fset.addFile(filename, -1, byteLength(content))!;
  tf.setLinesForContent(content);
  new Checker(pass, filename, null).nonGoFile(tf.base(), content);
}

class Checker {
  // In the file header, before or adjoining the package declaration.
  inHeader = true;

  constructor(
    private readonly pass: Pass<unknown>,
    private readonly filename: string,
    private readonly file: ast.File | null,
  ) {}

  nonGoFile(pos: token.Pos, text: string): void {
    let inStar = false;
    let offset = 0;
    for (const raw of text.split("\n")) {
      const lineOffset = offset;
      offset += byteLength(raw) + 1;
      if (!inStar && raw.startsWith("//")) {
        this.comment(pos + lineOffset, raw);
        continue;
      }
      // Cut out /* */ comments, so a commented-out // comment is skipped.
      let line = raw;
      for (;;) {
        line = line.trim();
        if (inStar) {
          const i = line.indexOf("*/");
          if (i < 0) {
            line = "";
            break;
          }
          line = line.slice(i + 2);
          inStar = false;
          continue;
        }
        inStar = line.startsWith("/*");
        if (!inStar) {
          break;
        }
        line = line.slice(2);
      }
      if (line !== "") {
        // The rest of the file cannot be parsed reliably, so stop.
        break;
      }
    }
  }

  comment(pos: token.Pos, line: string): void {
    if (!line.startsWith("//go:")) {
      return;
    }
    // Testing hack: stop at // ERROR.
    const e = line.indexOf(" // ERROR ");
    if (e >= 0) {
      line = line.slice(0, e);
    }
    let verb = line;
    const i = [...line].findIndex((ch) => isSpace(ch.codePointAt(0)!));
    if (i >= 0) {
      const index = [...line].slice(0, i).join("").length;
      verb = line.slice(0, index);
      const r = line.codePointAt(index)!;
      if (r !== 0x20 && r !== 0x09 && r !== 0x0a) {
        this.pass.report({ pos, message: `invalid space ${quoteSpace(r)} in ${verb} directive` });
      }
    }
    if (verb !== "//go:debug") {
      return;
    }
    let message = "";
    if (this.file === null) {
      message = "//go:debug directive only valid in Go source files";
    } else if (this.file.name!.name !== "main" && !this.filename.endsWith("_test.go")) {
      message = "//go:debug directive only valid in package main or test";
    } else if (!this.inHeader) {
      message = "//go:debug directive only valid before package declaration";
    }
    if (message !== "") {
      this.pass.report({ pos, message });
    }
  }
}

// isSpace reports whether r is a space as unicode.IsSpace defines it.
function isSpace(r: number): boolean {
  return (
    (r >= 0x09 && r <= 0x0d) ||
    r === 0x20 ||
    r === 0x85 ||
    r === 0xa0 ||
    r === 0x1680 ||
    (r >= 0x2000 && r <= 0x200a) ||
    r === 0x2028 ||
    r === 0x2029 ||
    r === 0x202f ||
    r === 0x205f ||
    r === 0x3000
  );
}

// quoteSpace formats a space other than ' ' as %#q does: none are printable.
function quoteSpace(r: number): string {
  const escapes: Record<string, string> = { "\v": "\\v", "\f": "\\f", "\r": "\\r" };
  return `'${escapes[String.fromCodePoint(r)] ?? `\\u${r.toString(16).padStart(4, "0")}`}'`;
}
