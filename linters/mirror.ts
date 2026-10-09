import * as ast from "go/ast";
import { defineAnalyzer, formatNode, type Pass } from "tsk";
import { inspect } from "tsk/passes";

// Violation describes a call whose converted arguments could instead be
// passed to a mirror function, as strings.Contains(string(b), ...) can be
// bytes.Contains(b, ...).
interface Violation {
  pkg: string;
  // recv names the receiver type of a method, or is "" for a function.
  recv: string;
  name: string;
  alt: string;
  // altPkg is the package of a function's alternative, if it differs.
  altPkg: string;
  // args lists the indexes of arguments that must all be conversions.
  args: number[];
  // argType is the type of each converted value.
  argType: string;
}

// mirrored returns both directions of a []byte and string pair, such as
// bytes.Write and WriteString.
function mirrored(pkg: string, recv: string, bytesName: string, stringName: string, args: number[], altPkg = ""): Violation[] {
  return [
    { pkg, recv, name: bytesName, alt: stringName, altPkg, args, argType: "string" },
    { pkg: altPkg || pkg, recv, name: stringName, alt: bytesName, altPkg: altPkg && pkg, args, argType: "[]byte" },
  ];
}

const writers: [string, string][] = [
  ["bytes", "Buffer"],
  ["strings", "Builder"],
  ["hash/maphash", "Hash"],
  ["bufio", "Writer"],
  ["net/http/httptest", "ResponseRecorder"],
  ["os", "File"],
];

const runeWriters = new Set(["bytes.Buffer", "strings.Builder", "bufio.Writer"]);

const bytesStringsFunctions: [string, number[]][] = [
  ["Compare", [0, 1]],
  ["Contains", [0, 1]],
  ["ContainsAny", [0]],
  ["ContainsRune", [0]],
  ["Count", [0, 1]],
  ["EqualFold", [0, 1]],
  ["HasPrefix", [0, 1]],
  ["HasSuffix", [0, 1]],
  ["Index", [0, 1]],
  ["IndexAny", [0]],
  ["IndexByte", [0]],
  ["IndexFunc", [0]],
  ["IndexRune", [0]],
  ["LastIndex", [0, 1]],
  ["LastIndexAny", [0]],
  ["LastIndexByte", [0]],
  ["LastIndexFunc", [0]],
];

const regexpMethods: [string, string][] = [
  ["Match", "MatchString"],
  ["FindAllIndex", "FindAllStringIndex"],
  ["FindAllSubmatchIndex", "FindAllStringSubmatchIndex"],
  ["FindIndex", "FindStringIndex"],
  ["FindSubmatchIndex", "FindStringSubmatchIndex"],
];

const utf8Functions: [string, string][] = [
  ["Valid", "ValidString"],
  ["FullRune", "FullRuneInString"],
  ["RuneCount", "RuneCountInString"],
  ["DecodeLastRune", "DecodeLastRuneInString"],
  ["DecodeRune", "DecodeRuneInString"],
];

const violations: Violation[] = [
  ...mirrored("bytes", "", "NewBuffer", "NewBufferString", [0]),
  ...bytesStringsFunctions.flatMap(([name, args]) => mirrored("bytes", "", name, name, args, "strings")),
  ...mirrored("regexp", "", "Match", "MatchString", [1]),
  ...regexpMethods.flatMap(([bytesName, stringName]) => mirrored("regexp", "Regexp", bytesName, stringName, [0])),
  ...mirrored("hash/maphash", "", "Bytes", "String", [1]),
  ...utf8Functions.flatMap(([bytesName, stringName]) => mirrored("unicode/utf8", "", bytesName, stringName, [0])),
  ...writers.flatMap(([pkg, recv]) => [
    ...mirrored(pkg, recv, "Write", "WriteString", [0]),
    ...(runeWriters.has(`${pkg}.${recv}`) ? [{ pkg, recv, name: "WriteString", alt: "WriteRune", altPkg: "", args: [0], argType: "rune" }] : []),
  ]),
];

export default defineAnalyzer({
  name: "mirror",
  doc: "reports wrong mirror patterns of bytes/strings usage",
  requires: [inspect],
  run(pass) {
    for (const cursor of pass.resultOf(inspect).root().preorder(ast.CallExpr)) {
      check(pass, cursor.node() as ast.CallExpr);
    }
  },
});

function check(pass: Pass<unknown>, call: ast.CallExpr): void {
  const fun = call.fun;
  if (fun?.$type === "Ident") {
    // A function from a dot import.
    const object = pass.typesInfo.uses.get(fun);
    const pkg = object?.$type === "Func" ? object.pkg() : null;
    if (pkg !== null && pkg !== pass.pkg && object!.parent() === pkg.scope()) {
      checkFunction(pass, call, pkg.path(), fun.name, null);
    }
    return;
  }
  if (fun?.$type !== "SelectorExpr" || fun.x?.$type !== "Ident") {
    return;
  }
  const name = fun.sel!.name;
  const object = pass.typesInfo.uses.get(fun.x);
  if (object?.$type === "PkgName") {
    checkFunction(pass, call, object.imported()!.path(), name, fun.x);
    return;
  }
  const tv = pass.typesInfo.types.get(fun.x);
  if (!tv?.isValue() || !tv.type) {
    return;
  }
  const recv = tv.type.string().replace(/^\*/, "");
  for (const v of violations) {
    if (v.recv !== "" && `${v.pkg}.${v.recv}` === recv && v.name === name && report(pass, v, call, fun.x)) {
      return;
    }
  }
}

function checkFunction(pass: Pass<unknown>, call: ast.CallExpr, pkg: string, name: string, base: ast.Expr | null): void {
  const v = violations.find((v) => v.recv === "" && v.pkg === pkg && v.name === name);
  if (v !== undefined) {
    report(pass, v, call, base);
  }
}

// report reports a call if each of the violation's arguments converts a
// value of its argument type, returning whether it did.
function report(pass: Pass<unknown>, v: Violation, call: ast.CallExpr, base: ast.Expr | null): boolean {
  const unwrapped = new Map<number, ast.Expr>();
  for (const i of v.args) {
    const arg = call.args[i];
    if (arg?.$type !== "CallExpr" || (arg.fun?.$type !== "ArrayType" && arg.fun?.$type !== "Ident") || arg.args.length === 0) {
      continue;
    }
    const target = typeString(pass, arg.fun);
    if ((target === "[]byte" || target === "string") && typeString(pass, arg.args[0]!).replace(/^untyped rune$/, "rune") === v.argType) {
      unwrapped.set(i, arg.args[0]!);
    }
  }
  if (unwrapped.size !== v.args.length) {
    return false;
  }
  const pkgName = (pkg: string) => pkg.slice(pkg.lastIndexOf("/") + 1);
  const message =
    v.recv !== "" ? `avoid allocations with (*${pkgName(v.pkg)}.${v.recv}).${v.alt}` : `avoid allocations with ${pkgName(v.altPkg || v.pkg)}.${v.alt}`;
  // A fix to another package would need its import, so only same-package
  // alternatives are fixed.
  const fixable = (v.recv !== "" || v.altPkg === "") && !formatNode(call, pass.fset).includes("\n");
  const args = call.args.map((arg, i) => formatNode(unwrapped.get(i) ?? arg!, pass.fset));
  const replacement = `${base === null ? "" : `${formatNode(base, pass.fset)}.`}${v.alt}(${args.join(", ")})`;
  pass.report({
    pos: call.pos(),
    message,
    suggestedFixes: fixable ? [{ message: "Fix Issue With", textEdits: [{ pos: call.pos(), end: call.end(), newText: replacement }] }] : [],
  });
  return true;
}

function typeString(pass: Pass<unknown>, expr: ast.Expr): string {
  return pass.typesInfo.typeOf(expr)?.string() ?? "";
}
