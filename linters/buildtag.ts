// Port of golang.org/x/tools/go/analysis/passes/buildtag at v0.50.0.
import type * as ast from "go/ast";
import * as constraint from "go/build/constraint";
import * as parser from "go/parser";
import type * as token from "go/token";
import { defineAnalyzer, type Pass } from "tsk";
import { quote } from "./internal/strconv";
import { byteLength } from "./internal/utf8";

export default defineAnalyzer({
  name: "buildtag",
  doc: "check //go:build and // +build directives",
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
          f = parser.parseFile(pass.fset, name, pass.readFile(name), parser.ParseComments | parser.SkipObjectResolution)!;
        } catch {
          // Not valid Go source code: not ours to diagnose. Upstream stops here.
          return;
        }
        checkGoFile(pass, f);
      } else {
        checkOtherFile(pass, name);
      }
    }
  },
});

function checkGoFile(pass: Pass<unknown>, f: ast.File): void {
  const check = new Checker(pass);
  for (const group of f.comments) {
    // A +build comment is ignored after or adjoining the package declaration.
    if (group!.end() + 1 >= f.package) {
      check.plusBuildOK = false;
    }
    // A //go:build comment is ignored after the package declaration.
    if (group!.pos() >= f.package) {
      check.goBuildOK = false;
    }
    for (const c of group!.list) {
      // "+build" is ignored within or after a /*...*/ comment.
      if (!c!.text.startsWith("//")) {
        check.plusBuildOK = false;
      }
      check.comment(c!.slash, c!.text);
    }
  }
  check.finish();
}

function checkOtherFile(pass: Pass<unknown>, filename: string): void {
  const content = pass.readFile(filename);
  const tf = pass.fset.addFile(filename, -1, byteLength(content))!;
  tf.setLinesForContent(content);
  const check = new Checker(pass);
  check.file(tf.base(), content);
  check.finish();
}

// splitLines splits text after each newline, keeping it, as the upstream loops do.
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

class Checker {
  plusBuildOK = true;
  goBuildOK = true;
  private crossCheck = true;
  private inStar = false;
  private goBuildPos: token.Pos = 0;
  private plusBuildPos: token.Pos = 0;
  private goBuild: constraint.Expr | null = null;
  // The +build constraints, whose AND upstream builds.
  private plusBuild: constraint.Expr[] = [];

  constructor(private readonly pass: Pass<unknown>) {}

  private report(pos: token.Pos, message: string): void {
    this.pass.report({ pos, message });
  }

  file(pos: token.Pos, text: string): void {
    const lines = splitLines(text);
    // +build comments are valid only in leading // comments followed by a blank line.
    let plusBuildCutoff = 0;
    let offset = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("//") && line !== "") {
        break;
      }
      if (line === "") {
        plusBuildCutoff = offset;
      }
      offset += byteLength(raw);
    }

    this.inStar = false;
    offset = 0;
    for (const raw of lines) {
      const lineOffset = offset;
      offset += byteLength(raw);
      this.plusBuildOK = lineOffset < plusBuildCutoff;
      if (raw.startsWith("//")) {
        this.comment(pos + lineOffset, raw);
        continue;
      }
      // Skip /* */ comments, looking for the first non-comment line.
      let line = raw;
      for (;;) {
        line = line.trim();
        if (this.inStar) {
          const i = line.indexOf("*/");
          if (i < 0) {
            line = "";
            break;
          }
          line = line.slice(i + 2);
          this.inStar = false;
          continue;
        }
        if (line.startsWith("/*")) {
          this.inStar = true;
          line = line.slice(2);
          continue;
        }
        break;
      }
      if (line !== "") {
        // The rest of the file cannot be parsed reliably, so stop.
        break;
      }
    }
  }

  comment(pos: token.Pos, text: string): void {
    if (text.startsWith("//")) {
      if (text.includes("+build")) {
        this.plusBuildLine(pos, text);
      }
      if (text.includes("//go:build")) {
        this.goBuildLine(pos, text);
      }
    }
    if (text.startsWith("/*")) {
      const i = text.indexOf("\n");
      if (i >= 0) {
        // A multiline /* */ comment: process interior lines.
        this.inStar = true;
        let p = pos + byteLength(text.slice(0, i + 1));
        for (const line of splitLines(text.slice(i + 1))) {
          if (line.startsWith("//")) {
            this.comment(p, line);
          }
          p += byteLength(line);
        }
        this.inStar = false;
      }
    }
  }

  private goBuildLine(pos: token.Pos, line: string): void {
    if (!constraint.isGoBuild(line)) {
      if (!line.startsWith("//go:build") && constraint.isGoBuild(`//${line.slice(2).trim()}`)) {
        this.report(pos, "malformed //go:build line (space between // and go:build)");
      }
      return;
    }
    if (!this.goBuildOK || this.inStar) {
      this.report(pos, "misplaced //go:build comment");
      this.crossCheck = false;
      return;
    }
    if (this.goBuildPos === 0) {
      this.goBuildPos = pos;
    } else {
      this.report(pos, "unexpected extra //go:build line");
      this.crossCheck = false;
    }
    // Testing hack: stop at // ERROR.
    const i = line.indexOf(" // ERROR ");
    if (i >= 0) {
      line = line.slice(0, i);
    }
    let x: constraint.Expr;
    try {
      x = constraint.parse(line)!;
    } catch (err) {
      this.report(pos, (err as Error).message);
      this.crossCheck = false;
      return;
    }
    this.tags(pos, x);
    this.goBuild ??= x;
  }

  private plusBuildLine(pos: token.Pos, line: string): void {
    line = line.trim();
    if (!constraint.isPlusBuild(line)) {
      // +build not at the beginning: only report early in the file.
      if (this.plusBuildOK && !line.startsWith("// want")) {
        this.report(pos, "possible malformed +build comment");
      }
      return;
    }
    if (!this.plusBuildOK) {
      this.report(pos, "misplaced +build comment");
      this.crossCheck = false;
    }
    if (this.plusBuildPos === 0) {
      this.plusBuildPos = pos;
    }
    // Testing hack: stop at // ERROR.
    const i = line.indexOf(" // ERROR ");
    if (i >= 0) {
      line = line.slice(0, i);
    }
    const fields = line.slice(2).trim().split(/\s+/);
    for (const arg of fields.slice(1)) {
      for (let elem of arg.split(",")) {
        if (elem.startsWith("!!")) {
          this.report(pos, `invalid double negative in build constraint: ${arg}`);
          this.crossCheck = false;
          continue;
        }
        if (elem.startsWith("!")) {
          elem = elem.slice(1);
        }
        if (!/^[\p{L}\p{Nd}_.]*$/u.test(elem)) {
          this.report(pos, `invalid non-alphanumeric build constraint: ${arg}`);
          this.crossCheck = false;
        }
      }
    }
    if (this.crossCheck) {
      let y: constraint.Expr;
      try {
        y = constraint.parse(line)!;
      } catch (err) {
        this.report(pos, (err as Error).message);
        this.crossCheck = false;
        return;
      }
      this.tags(pos, y);
      this.plusBuild.push(y);
    }
  }

  finish(): void {
    if (!this.crossCheck || this.plusBuildPos === 0 || this.goBuildPos === 0) {
      return;
    }
    // Both //go:build and // +build lines, with no errors: check they match.
    let lines: string[];
    try {
      lines = constraint.plusBuildLines(this.goBuild);
    } catch (err) {
      this.report(this.goBuildPos, (err as Error).message);
      return;
    }
    const want: constraint.Expr[] = [];
    for (const line of lines) {
      try {
        want.push(constraint.parse(line)!);
      } catch {
        // Not the user's fault: do not report.
        return;
      }
    }
    if (andString(want) !== andString(this.plusBuild)) {
      this.report(this.plusBuildPos, "+build lines do not match //go:build condition");
    }
  }

  // tags reports malformed go versions among the tags of e.
  private tags(pos: token.Pos, e: constraint.Expr): void {
    // Eval visits every tag, as it does not short-circuit.
    e.eval((tag) => {
      if (malformedGoTag(tag)) {
        this.report(pos, `invalid go version ${quote(tag)} in build constraint`);
      }
      return false;
    });
  }
}

// andString formats the left-nested AND of exprs as constraint.AndExpr.String does.
function andString(exprs: constraint.Expr[]): string {
  if (exprs.length === 1) {
    return exprs[0].string();
  }
  const andArg = (x: constraint.Expr) => (x.$type === "OrExpr" ? `(${x.string()})` : x.string());
  return exprs.slice(1).reduce((s, y) => `${s} && ${andArg(y)}`, andArg(exprs[0]));
}

// malformedGoTag reports whether tag is likely a malformed go version constraint.
function malformedGoTag(tag: string): boolean {
  if (!tag.startsWith("go1")) {
    // Check for close misspellings of the "go1." prefix.
    for (const pre of ["go.", "g1.", "go"]) {
      if (tag.startsWith(pre) && validGoVersion(`go1.${tag.slice(pre.length)}`)) {
        return true;
      }
    }
    return false;
  }
  return !validGoVersion(tag);
}

// validGoVersion reports whether tag is a valid go version. Tags are valid
// constraint tokens, so parsing one yields its TagExpr.
function validGoVersion(tag: string): boolean {
  return constraint.goVersion(constraint.parse(`//go:build ${tag}`)) !== "";
}
