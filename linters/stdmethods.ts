// Port of golang.org/x/tools/go/analysis/passes/stdmethods at v0.50.0.
import * as ast from "go/ast";
import * as types from "go/types";
import { defineAnalyzer, type Pass } from "tsk";
import { inspect } from "tsk/passes";

// canonicalMethods lists the parameter and result types of methods that are
// found by dynamic interface checks, so a wrong signature compiles. A type
// with a = prefix signals the canonical meaning: unless it matches, the method is not checked.
const canonicalMethods = new Map<string, { args: string[]; results: string[] }>([
  ["As", { args: ["any"], results: ["bool"] }], // errors.As
  ["Format", { args: ["=fmt.State", "rune"], results: [] }], // fmt.Formatter
  ["GobDecode", { args: ["[]byte"], results: ["error"] }], // gob.GobDecoder
  ["GobEncode", { args: [], results: ["[]byte", "error"] }], // gob.GobEncoder
  ["Is", { args: ["error"], results: ["bool"] }], // errors.Is
  ["MarshalJSON", { args: [], results: ["[]byte", "error"] }], // json.Marshaler
  ["MarshalXML", { args: ["*xml.Encoder", "xml.StartElement"], results: ["error"] }], // xml.Marshaler
  ["ReadByte", { args: [], results: ["byte", "error"] }], // io.ByteReader
  ["ReadFrom", { args: ["=io.Reader"], results: ["int64", "error"] }], // io.ReaderFrom
  ["ReadRune", { args: [], results: ["rune", "int", "error"] }], // io.RuneReader
  ["Scan", { args: ["=fmt.ScanState", "rune"], results: ["error"] }], // fmt.Scanner
  ["Seek", { args: ["=int64", "int"], results: ["int64", "error"] }], // io.Seeker
  ["UnmarshalJSON", { args: ["[]byte"], results: ["error"] }], // json.Unmarshaler
  ["UnmarshalXML", { args: ["*xml.Decoder", "xml.StartElement"], results: ["error"] }], // xml.Unmarshaler
  ["UnreadByte", { args: [], results: ["error"] }],
  ["UnreadRune", { args: [], results: ["error"] }],
  ["Unwrap", { args: [], results: ["error"] }], // errors.Unwrap
  ["WriteByte", { args: ["byte"], results: ["error"] }], // jpeg.writer (matching bufio.Writer)
  ["WriteTo", { args: ["=io.Writer"], results: ["int64", "error"] }], // io.WriterTo
]);

export default defineAnalyzer({
  name: "stdmethods",
  doc: `check signature of methods of well-known interfaces

Sometimes a type may be intended to satisfy an interface but may fail to
do so because of a mistake in its method signature.
For example, the result of this WriteTo method should be (int64, error),
not error, to satisfy io.WriterTo:

	type myWriterTo struct{...}
	func (myWriterTo) WriteTo(w io.Writer) error { ... }

This check ensures that each method whose name matches one of several
well-known interface methods from the standard library has the correct
signature for that interface.

Checked method names include:

	Format GobEncode GobDecode MarshalJSON MarshalXML
	Peek ReadByte ReadFrom ReadRune Scan Seek
	UnmarshalJSON UnreadByte UnreadRune WriteByte
	WriteTo`,
  group: "govet",
  requires: [inspect],
  run(pass) {
    const errorType = types.Universe!.lookup("error")!.type()!.underlying() as types.Interface;
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.FuncDecl, ast.InterfaceType)) {
      const n = cursor.node();
      if (n?.$type === "FuncDecl") {
        if (n.recv !== null) {
          canonicalMethod(pass, errorType, n.name!);
        }
      } else if (n?.$type === "InterfaceType") {
        for (const field of n.methods!.list) {
          for (const id of field!.names) {
            canonicalMethod(pass, errorType, id!);
          }
        }
      }
    }
  },
});

function canonicalMethod(pass: Pass<unknown>, errorType: types.Interface, id: ast.Ident): void {
  const expect = canonicalMethods.get(id.name);
  if (expect === undefined) {
    return;
  }
  const sign = pass.typesInfo.defs.get(id)!.type() as types.Signature;
  const args = tupleTypes(sign.params());
  const results = tupleTypes(sign.results());

  // WriteTo with more than one argument, not trying to implement
  // io.WriterTo, comes up often enough to skip.
  if (id.name === "WriteTo" && args.length > 1) {
    return;
  }
  // Is, As and Unwrap only apply when the type implements error.
  if (id.name === "Is" || id.name === "As" || id.name === "Unwrap") {
    const recv = sign.recv();
    if (recv === null || !types.implements_(recv.type(), errorType)) {
      return;
    }
  }
  // Unwrap has two possible signatures.
  if (id.name === "Unwrap") {
    if (args.length === 0 && results.length === 1) {
      const t = typeString(results[0]);
      if (t === "error" || t === "[]error") {
        return;
      }
    }
    pass.report({ pos: id.pos(), end: id.end(), message: "method Unwrap() should have signature Unwrap() error or Unwrap() []error" });
    return;
  }
  // Do the =s, if any, all match?
  if (!matchParams(expect.args, args, "=") || !matchParams(expect.results, results, "=")) {
    return;
  }
  // Everything must match.
  if (!matchParams(expect.args, args, "") || !matchParams(expect.results, results, "")) {
    let expectFmt = `${id.name}(${argjoin(expect.args)})`;
    if (expect.results.length === 1) {
      expectFmt += ` ${argjoin(expect.results)}`;
    } else if (expect.results.length > 1) {
      expectFmt += ` (${argjoin(expect.results)})`;
    }
    const actual = id.name + typeString(sign).replace(/^func/, "");
    pass.report({ pos: id.pos(), end: id.end(), message: `method ${actual} should have signature ${expectFmt}` });
  }
}

function typeString(typ: types.Type | null): string {
  return types.typeString(typ, (pkg) => pkg?.name() ?? "");
}

function argjoin(x: string[]): string {
  return x.map((s) => s.replace(/^=/, "")).join(", ");
}

// matchParams reports whether each type in expect with the given prefix
// matches the corresponding type in actual.
function matchParams(expect: string[], actual: (types.Type | null)[], prefix: string): boolean {
  for (const [i, x] of expect.entries()) {
    if (!x.startsWith(prefix)) {
      continue;
    }
    if (i >= actual.length || !matchParamType(x, actual[i])) {
      return false;
    }
  }
  return !(prefix === "" && actual.length > expect.length);
}

// tupleTypes returns the types of a tuple's variables; a nil tuple is empty.
function tupleTypes(tuple: types.Tuple | null): (types.Type | null)[] {
  return tuple === null ? [] : Array.from(tuple.variables(), (v) => v!.type());
}

function matchParamType(expect: string, actual: types.Type | null): boolean {
  expect = expect.replace(/^=/, "");
  const t = typeString(actual);
  return t === expect || ((t === "any" || t === "interface{}") && (expect === "any" || expect === "interface{}"));
}
