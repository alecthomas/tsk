// Port of golang.org/x/tools/go/analysis/passes/stdversion at v0.50.0.
import * as ast from "go/ast";
import * as types from "go/types";
import * as version from "go/version";
import * as os from "os";
import * as filepath from "path/filepath";
import { defineAnalyzer, goroot } from "tsk";
import { inspect } from "tsk/passes";
import { atLeast, before } from "./internal/goversion";

export default defineAnalyzer({
  name: "stdversion",
  doc: `report uses of too-new standard library symbols

The stdversion analyzer reports references to symbols in the standard
library that were introduced by a Go release higher than the one in
force in the referring file. (Recall that the file's Go version is
defined by the 'go' directive its module's go.mod file, or by a
"//go:build go1.X" build tag at the top of the file.)

The analyzer does not report a diagnostic for a reference to a "too
new" field or method of a type that is itself "too new", as this may
have false positives, for example if fields or methods are accessed
through a type alias that is guarded by a Go version constraint.`,
  group: "govet",
  requires: [inspect],
  runDespiteErrors: true,
  run(pass) {
    // Modules before go1.21 did not clearly treat the go directive as a
    // toolchain requirement.
    const pkgVersion = pass.pkg.goVersion();
    if (!atLeast(pkgVersion, "go1.21")) {
      return;
    }
    const memo = new Map<types.Package, Map<string, Map<types.Object, StdSymbol>>>();
    const disallowedSymbols = (pkg: types.Package, fileVersion: string) => {
      let byVersion = memo.get(pkg);
      if (byVersion === undefined) {
        byVersion = new Map();
        memo.set(pkg, byVersion);
      }
      let disallowed = byVersion.get(fileVersion);
      if (disallowed === undefined) {
        disallowed = tooNewStdSymbols(pkg, fileVersion);
        byVersion.set(fileVersion, disallowed);
      }
      return disallowed;
    };
    for (const fileCursor of pass.resultOf(inspect).root().children()) {
      const file = fileCursor.node() as ast.File;
      // Generated files, such as cgo's, are not checked.
      const fileVersion = ast.isGenerated(file) ? "" : lang(pass.typesInfo.fileVersions.get(file) ?? "");
      if (fileVersion === "") {
        continue;
      }
      for (const cursor of fileCursor.preorder(ast.Ident)) {
        const n = cursor.node() as ast.Ident;
        const obj = pass.typesInfo.uses.get(n) ?? null;
        const objPkg = obj?.pkg() ?? null;
        if (obj === null || objPkg === null) {
          continue;
        }
        const sym = disallowedSymbols(objPkg, fileVersion).get(origin(obj));
        if (sym !== undefined) {
          pass.report({
            pos: n.pos(),
            end: n.end(),
            message: `${objPkg.name()}.${sym.name} requires ${sym.version} or later (${fileVersion !== pkgVersion ? "file" : "module"} is ${fileVersion})`,
          });
        }
      }
    }
  },
});

// Returns the language version of a valid file version, or "" for an unknown one.
function lang(v: string): string {
  return version.isValid(v) ? version.lang(v) : "";
}

// Returns the original uninstantiated symbol for obj.
function origin(obj: types.Object): types.Object {
  switch (obj.$type) {
    case "Var":
    case "Func":
      return obj.origin() ?? obj;
    case "TypeName": {
      const t = obj.type();
      // Aliases are not unaliased.
      return t?.$type === "Named" ? (t.origin()?.obj() ?? obj) : obj;
    }
  }
  return obj;
}

type Kind = "type" | "func" | "var" | "const" | "field" | "method";

interface StdSymbol {
  // As in the API files: "Buffer", "Point.X", "(*Buffer).Grow", or "(Reader).Read".
  name: string;
  kind: Kind;
  // The Go release that first included the symbol, such as "go1.22".
  version: string;
}

// Port of internal/typesinternal.TooNewStdSymbols: the symbols of pkg that
// are not available at the version, including fields and methods.
function tooNewStdSymbols(pkg: types.Package, v: string): Map<types.Object, StdSymbol> {
  const disallowed = new Map<types.Object, StdSymbol>();
  const path = pkg.path();
  // These are accessible before their release only with build tags unknown here.
  if (path === "testing/synctest" && atLeast(v, "go1.24")) {
    return disallowed;
  }
  if ((path === "encoding/json/v2" || path === "encoding/json/jsontext") && atLeast(v, "go1.25")) {
    return disallowed;
  }
  const symbols = packageSymbols(path);
  const scope = pkg.scope()!;
  for (const sym of symbols) {
    if (before(v, sym.version) && (sym.kind === "func" || sym.kind === "var" || sym.kind === "const" || sym.kind === "type")) {
      const obj = scope.lookup(sym.name);
      if (obj !== null) {
        disallowed.set(obj, sym);
      }
    }
  }
  // Fields and methods of a disallowed type are allowed, so compatibility
  // shims declaring the type for older versions are not reported.
  const depth = new Map<types.Object, number>();
  for (const sym of symbols) {
    if (!before(v, sym.version)) {
      continue;
    }
    let found: [types.Object | null, number[], boolean] | null = null;
    if (sym.kind === "field") {
      const [typename, name] = cut(sym.name, ".");
      const t = scope.lookup(typename);
      if (t !== null && !disallowed.has(t)) {
        found = types.lookupFieldOrMethod(t.type(), false, pkg, name);
      }
    } else if (sym.kind === "method") {
      const [recvPart, name] = cut(sym.name, ".");
      let recv = recvPart.slice(1, -1);
      const ptr = recv.startsWith("*");
      if (ptr) {
        recv = recv.slice(1);
      }
      const t = scope.lookup(recv);
      if (t !== null && !disallowed.has(t)) {
        found = types.lookupFieldOrMethod(t.type(), ptr, pkg, name);
      }
    }
    const obj = found?.[0] ?? null;
    if (obj !== null) {
      // With embedding, several symbols may name one object; the shortest
      // index path wins.
      const indices = found![1];
      const min = depth.get(obj);
      if (min === undefined || indices.length < min) {
        depth.set(obj, indices.length);
        disallowed.set(obj, sym);
      }
    }
  }
  return disallowed;
}

function cut(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
}

// An API file of $GOROOT/api and the minor Go release it describes.
interface APIFile {
  minor: number;
  text: string;
}

// Caches of $GOROOT/api, which never changes for a toolchain: the result
// cache's key covers go env, so later packages need not record the reads.
let apiFiles: APIFile[] | undefined;
const symbolsByPackage = new Map<string, StdSymbol[]>();

// Reads go1.txt, go1.N.txt up to the first missing N, and then api/next/*.txt
// as that N, as internal/stdlib's generator does.
function readAPIFiles(): APIFile[] {
  const dir = filepath.join(goroot(), "api");
  const names = new Set(os.readDir(dir).map((entry) => entry!.name()));
  const files: APIFile[] = [];
  let minor = 0;
  for (; ; minor++) {
    const name = minor === 0 ? "go1.txt" : `go1.${minor}.txt`;
    if (!names.has(name)) {
      break;
    }
    files.push({ minor, text: os.readFile(filepath.join(dir, name)) });
  }
  if (names.has("next")) {
    const next = filepath.join(dir, "next");
    const texts = os
      .readDir(next)
      .map((entry) => entry!.name())
      .filter((name) => name.endsWith(".txt"))
      .map((name) => os.readFile(filepath.join(next, name)));
    files.push({ minor, text: texts.join("") });
  }
  return files;
}

const symbolRegexp = /^pkg (\S+).*?, (var|func|type|const|method \([^)]*\)) ([\p{L}\p{Nd}_]+)(.*)/u;

// Returns the exported symbols of the standard library package at path, as
// internal/stdlib's manifest records them.
function packageSymbols(path: string): StdSymbol[] {
  let symbols = symbolsByPackage.get(path);
  if (symbols !== undefined) {
    return symbols;
  }
  symbols = [];
  symbolsByPackage.set(path, symbols);
  // Only paths whose first element has no dot can be in the standard library.
  if (cut(path, "/")[0].includes(".")) {
    return symbols;
  }
  apiFiles ??= readAPIFiles();
  // Earlier entries win: enums are redeclared and deprecations relisted later.
  const seen = new Set<string>();
  for (const file of apiFiles) {
    for (const line of packageLines(file.text, path)) {
      const sym = parseLine(line, file.minor);
      if (sym !== null && !seen.has(sym.name)) {
        seen.add(sym.name);
        symbols.push(sym);
      }
    }
  }
  return symbols;
}

// Yields the lines of an API file about the package at path, such as
// "pkg net, func Dial(...)" or "pkg syscall (linux-386), const X = 1".
function* packageLines(text: string, path: string): Generator<string> {
  for (const needle of [`pkg ${path}, `, `pkg ${path} (`]) {
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
      if (i > 0 && text[i - 1] !== "\n") {
        continue;
      }
      const end = text.indexOf("\n", i);
      yield text.slice(i, end < 0 ? text.length : end);
    }
  }
}

// Parses one API line as internal/stdlib's generator does, or returns null
// for a line it skips.
function parseLine(line: string, minor: number): StdSymbol | null {
  const m = symbolRegexp.exec(line);
  if (m === null) {
    return null;
  }
  let kind = m[2]!;
  let sym = m[3]!;
  const rest = m[4]!;
  if (kind.startsWith("method ")) {
    // e.g. "method (*Func) Pos() token.Pos"
    sym = `${removeTypeParam(kind.slice("method ".length))}.${sym}`;
    kind = "method";
  } else if (kind === "type" && rest.startsWith(" interface, ")) {
    // e.g. "type Type interface, Comparable() bool"
    const method = rest.slice(" interface, ".length);
    if (method.startsWith("unexported methods") || method.includes(" //deprecated") || !method.includes("(")) {
      return null;
    }
    sym = `(${sym}).${cut(method, "(")[0]}`;
    kind = "method";
  } else if (kind === "type" && rest.startsWith(" struct, ")) {
    // e.g. "type ParenExpr struct, Lparen token.Pos"
    let [name, typ] = cut(rest.slice(" struct, ".length), " ");
    // The API files name an embedded field "embedded"; strip "*pkg.T" to "T".
    if (name === "embedded") {
      typ = typ.startsWith("*") ? typ.slice(1) : typ;
      const dot = typ.indexOf(".");
      name = removeTypeParam(dot < 0 ? typ : typ.slice(dot + 1));
    }
    sym = `${sym}.${name}`;
    kind = "field";
  }
  return { name: sym, kind: kind as Kind, version: `go1.${minor}` };
}

// Removes type parameters, as "(*Foo[T])" becomes "(*Foo)".
function removeTypeParam(s: string): string {
  const i = s.indexOf("[");
  const j = s.lastIndexOf("]");
  return i > 0 && j > i ? s.slice(0, i) + s.slice(j + 1) : s;
}
